// Hearts game module. Wires the pure rules engine (games/hearts/rules.js)
// and simple bot heuristics (games/hearts/bots.js) into table.game state and
// the Socket.IO events the client drives. Follows the same factory/deps
// shape as games/lumo/index.js - see games/registry.js.
//
// Card play is server-authoritative throughout: every socket handler here
// resolves its own table via deps.findTableBySocket() and re-validates the
// move against rules.getLegalPlays() before touching any state, exactly like
// Lumo's performPlayCard(). Event names (heartsPlayCard, heartsPlayResult,
// etc.) are all unique to this module so they can never be delivered to or
// acted on by a Lumo table.

const rules = require('./rules');
const bots = require('./bots');

module.exports = function createHeartsGame(deps) {
  const io = deps.io;
  const tables = deps.tables;
  const shuffle = deps.shuffle;
  const getPlayerIndex = deps.getPlayerIndex;
  const clampInteger = deps.clampInteger;
  const emitTableState = deps.emitTableState;
  const emitLobbySnapshotAll = deps.emitLobbySnapshotAll;
  const addComputerPlayersToTable = deps.addComputerPlayersToTable;
  const findTableBySocket = deps.findTableBySocket;

  const PLAYER_COUNT = 4;
  const MIN_POINTS_TO_END_GAME = 50;
  const MAX_POINTS_TO_END_GAME = 500;
  const DEFAULT_POINTS_TO_END_GAME = 100;
  const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));
  // Gives sighted players a chance to actually see all four cards on the
  // table (via the hearts-trick-area panel) before the board clears for the
  // next trick, specifically when a bot won it - a bot winner never needs to
  // wait on a human ack the way a human winner's screen naturally does while
  // they read the result, so without this pause an all-bot stretch of tricks
  // could otherwise flash by with nothing to slow it down for onlookers.
  const BOT_TRICK_PAUSE_MS = Math.max(0, parseInt(process.env.BOT_TRICK_PAUSE_MS || '2000', 10));

  function normalizeMatchSettings(payload) {
    return {
      pointsToEndGame: clampInteger(payload && payload.pointsToEndGame, MIN_POINTS_TO_END_GAME, MAX_POINTS_TO_END_GAME, DEFAULT_POINTS_TO_END_GAME)
    };
  }

  function getMatchSettings(table) {
    const matchSettings = table && table.matchSettings ? table.matchSettings : {};
    return {
      pointsToEndGame: clampInteger(matchSettings.pointsToEndGame, MIN_POINTS_TO_END_GAME, MAX_POINTS_TO_END_GAME, DEFAULT_POINTS_TO_END_GAME)
    };
  }

  function initializeGameState(table) {
    table.game = {
      handNumber: 0,
      direction: 'hold',
      phase: 'waiting',
      hands: [[], [], [], []],
      passSelections: [null, null, null, null],
      heartsBroken: false,
      trick: [],
      trickNumber: 1,
      leaderIndex: null,
      turnIndex: null,
      captures: [[], [], [], []],
      lastTrick: null,
      pendingWinnerIndex: null,
      pendingTrickAcks: null,
      pendingHandAcks: null,
      botTimer: null
    };
  }

  function scheduleBotAction(table, run) {
    if (!table || !table.game) {
      return;
    }
    if (table.game.botTimer) {
      clearTimeout(table.game.botTimer);
    }
    table.game.botTimer = setTimeout(function () {
      table.game.botTimer = null;
      if (tables[table.id] === table) {
        run();
      }
    }, BOT_MOVE_DELAY_MS);
  }

  // turnPlayerId/turnPlayerName are included so that when phase is already
  // 'playing' (the hold-hand and post-passing transitions, where this is the
  // very first event a client sees for the new hand), the client can set its
  // turn state atomically with the phase flip instead of rendering the hand
  // with a stale turnPlayerId left over from the previous hand/trick until
  // the follow-up heartsTurnState event arrives a moment later - that gap
  // used to show every card in the 2-of-Clubs leader's hand as "not your
  // turn" for one render.
  function sendHands(table, receivedCardsByIndex) {
    const turnPlayer = table.game.turnIndex !== null ? table.players[table.game.turnIndex] : null;
    table.players.forEach(function (player, index) {
      io.to(player.id).emit('heartsHand', {
        hand: table.game.hands[index],
        handNumber: table.game.handNumber,
        direction: table.game.direction,
        phase: table.game.phase,
        receivedCards: receivedCardsByIndex ? receivedCardsByIndex[index] : null,
        turnPlayerId: turnPlayer ? turnPlayer.id : null,
        turnPlayerName: turnPlayer ? turnPlayer.name : ''
      });
    });
  }

  // Maps each seat to the three cards it received in the just-resolved pass,
  // using the same left/right/across geometry as rules.getPassTargetIndex()
  // (each seat has exactly one source seat, since the pass is a permutation).
  function computeReceivedCards(table, passSelections, direction) {
    return table.players.map(function (player, toIndex) {
      const fromIndex = table.players.findIndex(function (fromPlayer, i) {
        return rules.getPassTargetIndex(i, direction, table.players.length) === toIndex;
      });
      return fromIndex >= 0 ? passSelections[fromIndex].slice() : [];
    });
  }

  function beginHand(table) {
    table.game.handNumber = (table.game.handNumber || 0) + 1;
    const direction = rules.getPassDirection(table.game.handNumber);
    table.game.direction = direction;

    const deck = rules.createDeck();
    shuffle(deck);
    table.game.hands = rules.deal(deck);
    table.game.heartsBroken = false;
    table.game.trick = [];
    table.game.trickNumber = 1;
    table.game.captures = [[], [], [], []];
    table.game.lastTrick = null;
    table.game.leaderIndex = null;
    table.game.turnIndex = null;
    table.game.passSelections = [null, null, null, null];

    if (direction === 'hold') {
      // Determined before sendHands() (rather than left to startPlayPhase()
      // below, which used to be the only place this ran) so the very first
      // heartsHand event for this hand already carries the real turn holder -
      // see sendHands()'s header comment for why that matters.
      const leaderIndex = rules.findTwoOfClubsHolder(table.game.hands);
      table.game.leaderIndex = leaderIndex;
      table.game.turnIndex = leaderIndex;
      table.game.phase = 'playing';
      // Emitted before sendHands()/startPlayPhase() below (rather than after,
      // as other transitions do) so that for the three seats that are *not*
      // the 2-of-Clubs leader - who get no other announcement for this
      // transition - this is the one message that survives. For the leader,
      // startPlayPhase()'s own "You have the 2 of Clubs. You start." message
      // fires after this and wins the single-slot ARIA live region race (see
      // srSpeak() in main.js) - which is fine, since that message is the more
      // actionable one for them right now.
      io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. Hold - no cards will be passed.');
      sendHands(table);
      emitTableState(table);
      startPlayPhase(table);
      return;
    }

    table.game.phase = 'passing';
    sendHands(table);
    // heartsPassPrompt below carries its own dedicated client-side
    // announcement (direction to pass, or Hold) - no generic actionNotice
    // needed here, which would otherwise be a same-tick duplicate racing the
    // same single-slot ARIA live region for no benefit (see srSpeak()).
    io.to(table.id).emit('heartsPassPrompt', { handNumber: table.game.handNumber, direction: direction });
    emitTableState(table);
    maybeScheduleBotPasses(table);
  }

  function maybeScheduleBotPasses(table) {
    // Unlike maybeScheduleBotTurn() (exactly one bot ever acts at a time, so
    // it can safely share table.game.botTimer), up to three bots may need to
    // pass simultaneously here - each needs its own independent timer rather
    // than the single shared botTimer field, or scheduling the second bot
    // would cancel the first bot's pending pass before it ever fires.
    table.players.forEach(function (player, index) {
      if (player.isBot && !table.game.passSelections[index]) {
        setTimeout(function () {
          if (tables[table.id] !== table || !table.game || table.game.phase !== 'passing' || table.game.passSelections[index]) {
            return;
          }
          const cards = bots.chooseBotPassCards(table.game.hands[index]);
          performSelectPassCards(table, player.id, cards);
        }, BOT_MOVE_DELAY_MS);
      }
    });
  }

  function performSelectPassCards(table, actingId, cards) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'passing') {
      io.to(actingId).emit('heartsPassResult', { success: false, message: 'Passing is not open right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex < 0) {
      return;
    }

    if (table.game.passSelections[playerIndex]) {
      io.to(actingId).emit('heartsPassResult', { success: false, message: 'You already submitted your pass' });
      return;
    }

    if (!Array.isArray(cards) || cards.length !== 3 || new Set(cards).size !== 3) {
      io.to(actingId).emit('heartsPassResult', { success: false, message: 'You must select exactly three cards' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    const allInHand = cards.every(function (card) { return hand.indexOf(card) !== -1; });
    if (!allInHand) {
      io.to(actingId).emit('heartsPassResult', { success: false, message: 'You can only pass cards from your own hand' });
      return;
    }

    table.game.passSelections[playerIndex] = cards.slice();
    io.to(actingId).emit('heartsPassResult', { success: true, message: 'Pass submitted.' });
    emitTableState(table);
    maybeResolvePassing(table);
  }

  function maybeResolvePassing(table) {
    if (table.game.passSelections.some(function (selection) { return !selection; })) {
      return;
    }

    const receivedCardsByIndex = computeReceivedCards(table, table.game.passSelections, table.game.direction);
    table.game.hands = rules.applyPass(table.game.hands, table.game.passSelections, table.game.direction);
    table.game.passSelections = [null, null, null, null];
    // Flip the phase to 'playing' before sendHands() so the heartsHand
    // payload's phase already reflects "passing is over" - the client uses
    // that field (plus receivedCards) to know it should announce the newly
    // received cards and move focus back into the hand, instead of treating
    // this as a brand new deal (see heartsHand handler in hearts-client.js).
    table.game.phase = 'playing';
    // Determined before sendHands() for the same reason as the hold-hand
    // branch of beginHand() - see sendHands()'s header comment.
    const leaderIndex = rules.findTwoOfClubsHolder(table.game.hands);
    table.game.leaderIndex = leaderIndex;
    table.game.turnIndex = leaderIndex;
    // No generic table-wide actionNotice here (unlike other transitions) -
    // each player's heartsHand payload above already carries their own
    // receivedCards, and the client announces that specifically. A shared
    // broadcast message would race the same single-slot ARIA live region
    // (see srSpeak() in main.js) and reliably clobber the per-player
    // announcement for 3 of every 4 players before it ever got voiced.
    sendHands(table, receivedCardsByIndex);
    startPlayPhase(table);
  }

  function startPlayPhase(table) {
    const leaderIndex = rules.findTwoOfClubsHolder(table.game.hands);
    table.game.leaderIndex = leaderIndex;
    table.game.turnIndex = leaderIndex;
    table.game.phase = 'playing';
    emitTableState(table);
    emitHeartsTurn(table);
  }

  function buildPublicTrick(table) {
    return table.game.trick.map(function (entry) {
      const player = table.players[entry.playerIndex];
      return {
        playerId: player ? player.id : null,
        playerName: player ? player.name : '',
        card: entry.card
      };
    });
  }

  // Builds the single combined announcement (if any) a given seat should hear
  // for this turn-state broadcast, per the "answer only what the blind player
  // needs answered" rules: what just happened (lastPlay, if someone other
  // than the recipient just played), whether it's now their turn, and the
  // 2-of-Clubs opening special case. lastPlay is only passed when a card was
  // just played *within* the current trick (see performPlayCard) - a
  // brand-new trick's leader (isNewTrick) never gets a lastPlay here because
  // nobody has played into it yet; the previous trick's winner was already
  // told "Your lead"/"takes the trick" via heartsTrickResult, so no further
  // "it's X's turn" narration is needed for a new trick's opening turn,
  // except the very first trick of the hand, where the 2C holder hasn't been
  // told anything yet.
  function buildTurnMessage(table, recipientIndex, lastPlay) {
    const turnIndex = table.game.turnIndex;

    if (lastPlay) {
      const parts = [];
      if (lastPlay.playerIndex !== recipientIndex) {
        parts.push(lastPlay.playerName + ' plays ' + rules.cardName(lastPlay.card) + '.');
      }
      if (lastPlay.justBroke) {
        parts.push('Hearts are now broken.');
      }
      if (recipientIndex === turnIndex) {
        parts.push('Your turn.');
      }
      return parts.length ? { text: parts.join(' '), startsHand: false } : null;
    }

    if (table.game.trick.length === 0 && table.game.trickNumber === 1 && recipientIndex === turnIndex) {
      return { text: 'You have the 2 of Clubs. You start.', startsHand: true };
    }

    return null;
  }

  // lastPlay (optional): { playerIndex, playerName, card, justBroke } for the
  // card that was just played into the still-open current trick - omitted
  // when this call represents a brand-new trick's opening turn (see
  // buildTurnMessage() above for why that case never needs one).
  function emitHeartsTurn(table, lastPlay) {
    const turnPlayer = table.players[table.game.turnIndex];
    if (!turnPlayer) {
      return;
    }

    const isFirstTrick = table.game.trickNumber === 1;
    const ledSuit = table.game.trick.length ? rules.suitOf(table.game.trick[0].card) : null;

    table.players.forEach(function (player, index) {
      const turnMessage = buildTurnMessage(table, index, lastPlay);
      const payload = {
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        handNumber: table.game.handNumber,
        trickNumber: table.game.trickNumber,
        heartsBroken: table.game.heartsBroken,
        ledSuit: ledSuit,
        ledSuitName: ledSuit ? rules.suitName(ledSuit) : null,
        trick: buildPublicTrick(table),
        message: turnMessage ? turnMessage.text : null,
        startsHand: !!(turnMessage && turnMessage.startsHand)
      };

      if (index === table.game.turnIndex) {
        payload.legalCards = rules.getLegalPlays(table.game.hands[index], table.game.trick, table.game.heartsBroken, isFirstTrick);
      }

      io.to(player.id).emit('heartsTurnState', payload);
    });

    maybeScheduleBotTurn(table);
  }

  function maybeScheduleBotTurn(table) {
    if (!table || !table.game || table.status !== 'in_game' || table.game.phase !== 'playing') {
      return;
    }

    const currentPlayer = table.players[table.game.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
      scheduleBotAction(table, function () {
        runBotTurn(table, currentPlayer.id);
      });
    }
  }

  function runBotTurn(table, botId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      return;
    }

    const playerIndex = getPlayerIndex(table, botId);
    if (playerIndex !== table.game.turnIndex) {
      return;
    }

    const bot = table.players[playerIndex];
    if (!bot || !bot.isBot) {
      return;
    }

    const isFirstTrick = table.game.trickNumber === 1;
    const card = bots.chooseBotCard(table.game.hands[playerIndex], table.game.trick, table.game.heartsBroken, isFirstTrick);
    if (card) {
      performPlayCard(table, botId, card);
    }
  }

  // Gives the specific rule a rejected play broke, per the "explain why,
  // don't just say no" accessibility rule - each branch matches a concrete
  // reason a blind player would need to hear (see the illegal-play examples
  // in the Hearts screen-reader announcement spec).
  function describeRejection(hand, trick, heartsBroken, isFirstTrick, card) {
    if (trick.length === 0 && isFirstTrick) {
      return 'You must play the 2 of Clubs.';
    }

    if (trick.length === 0) {
      if (!heartsBroken && rules.isHeart(card)) {
        return 'You cannot lead a Heart until Hearts have been broken.';
      }
      return 'You cannot lead that card right now.';
    }

    const ledSuit = rules.suitOf(trick[0].card);
    const sameSuit = hand.filter(function (c) { return rules.suitOf(c) === ledSuit; });
    if (sameSuit.length && rules.suitOf(card) !== ledSuit) {
      return 'You must follow ' + rules.suitName(ledSuit) + '.';
    }

    if (isFirstTrick && rules.isQueenOfSpades(card)) {
      return 'You cannot play the Queen of Spades on the first trick.';
    }
    if (isFirstTrick && rules.isHeart(card)) {
      return 'You cannot play a Heart on the first trick.';
    }

    return 'That card cannot be played right now.';
  }

  function performPlayCard(table, actingId, card) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('heartsPlayResult', { success: false, message: 'Unable to play a card right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('heartsPlayResult', { success: false, message: 'It is not your turn' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (typeof card !== 'string' || hand.indexOf(card) === -1) {
      io.to(actingId).emit('heartsPlayResult', { success: false, message: 'That card is not in your hand' });
      return;
    }

    const isFirstTrick = table.game.trickNumber === 1;
    const legal = rules.getLegalPlays(hand, table.game.trick, table.game.heartsBroken, isFirstTrick);
    if (legal.indexOf(card) === -1) {
      const message = describeRejection(hand, table.game.trick, table.game.heartsBroken, isFirstTrick, card);
      io.to(actingId).emit('heartsPlayResult', { success: false, message: message });
      return;
    }

    hand.splice(hand.indexOf(card), 1);
    table.game.trick.push({ playerIndex: playerIndex, card: card });

    let justBroke = false;
    if (rules.breaksHearts(card) && !table.game.heartsBroken) {
      table.game.heartsBroken = true;
      justBroke = true;
    }

    const player = table.players[playerIndex];
    const trickComplete = table.game.trick.length === PLAYER_COUNT;

    // The acting player already knows which card they just selected and
    // played, so their own result never restates it (see the Hearts
    // screen-reader announcement spec's "don't announce the player's own
    // action back to them" rule) - it only carries genuinely new state
    // (Hearts breaking), and only when that news isn't about to be folded
    // into a more decision-relevant trick-result announcement below.
    const ownMessage = (justBroke && !trickComplete) ? 'Hearts are now broken.' : '';
    io.to(actingId).emit('heartsPlayResult', { success: true, card: card, message: ownMessage });

    io.to(player.id).emit('heartsHand', {
      hand: hand,
      handNumber: table.game.handNumber,
      direction: table.game.direction,
      phase: table.game.phase
    });

    if (!trickComplete) {
      // turnIndex must be advanced before emitTableState() - the client
      // treats the tableState snapshot's hearts.turnPlayerId as authoritative
      // on every render (see renderHeartsPanel() in hearts-client.js), so
      // broadcasting it before the turn actually advances leaves the client
      // showing the player who just moved as still "on turn". The dedicated
      // heartsTurnState event immediately afterward would then get
      // overwritten back to that stale value the next time anything
      // re-renders, and the real next player (often a human) never sees
      // their turn - the game looks like it silently stalled.
      table.game.turnIndex = (playerIndex + 1) % PLAYER_COUNT;
      emitTableState(table);
      // Folds "{name} plays {card}" and "Your turn" into the single
      // heartsTurnState announcement each recipient gets (see
      // buildTurnMessage()) rather than a separate actionNotice broadcast -
      // two independent srSpeak() calls landing in the same tick would race
      // the single-slot ARIA live region and silently drop one of them.
      emitHeartsTurn(table, { playerIndex: playerIndex, playerName: player.name, card: card, justBroke: justBroke });
      return;
    }

    const winnerIndex = rules.resolveTrick(table.game.trick);
    const trickCards = table.game.trick.map(function (entry) { return entry.card; });
    table.game.captures[winnerIndex] = table.game.captures[winnerIndex].concat(trickCards);
    const trickPoints = trickCards.reduce(function (sum, c) { return sum + rules.cardPoints(c); }, 0);
    const winner = table.players[winnerIndex];
    // The winner of a Hearts trick leads the next one, so trickNumber 13
    // being the one that just resolved means the hand is over - there is no
    // "next lead" to promise the winner, so isFinalTrick lets the client omit
    // that (otherwise-wrong) part of the announcement (see heartsTrickResult
    // handler in hearts-client.js).
    const isFinalTrick = table.game.trickNumber >= 13;

    table.game.lastTrick = { cards: buildPublicTrick(table), winnerId: winner.id, winnerName: winner.name };
    io.to(table.id).emit('heartsTrickResult', {
      trick: table.game.lastTrick.cards,
      winnerId: winner.id,
      winnerName: winner.name,
      points: trickPoints,
      trickNumber: table.game.trickNumber,
      isFinalTrick: isFinalTrick,
      lastPlayerId: player.id,
      lastPlayerName: player.name,
      lastCard: card,
      justBroke: justBroke
    });

    table.game.trick = [];
    table.game.phase = 'trick_complete';
    // The winner leads the next trick, so this is already known - set it now
    // (same rule as the non-trick-completing branch above: turnIndex must be
    // advanced before emitTableState()) rather than leaving turnIndex on the
    // last-to-act player until tryAdvanceAfterTrick() runs after acks. The
    // client's heartsTrickResult handler already assumes this and sets its
    // own turnPlayerId to the winner immediately; leaving the server's
    // tableState snapshot stale here meant the very next generic 'tableState'
    // broadcast (also fired below) would overwrite that correct client value
    // back to the previous, non-winning player - showing the trick winner's
    // own cards as "not your turn" for one render right as they go to lead.
    table.game.turnIndex = winnerIndex;
    table.game.pendingWinnerIndex = winnerIndex;
    table.game.pendingTrickAcks = {};
    table.players.forEach(function (p) {
      if (!p.isBot) {
        table.game.pendingTrickAcks[p.id] = true;
      }
    });

    emitTableState(table);
    tryAdvanceAfterTrick(table);
  }

  function tryAdvanceAfterTrick(table) {
    if (!table.game || !table.game.pendingTrickAcks) {
      return;
    }
    if (Object.keys(table.game.pendingTrickAcks).length > 0 || table.status !== 'in_game') {
      return;
    }

    table.game.pendingTrickAcks = null;
    const winnerIndex = table.game.pendingWinnerIndex;
    table.game.pendingWinnerIndex = null;
    const winner = table.players[winnerIndex];

    function advance() {
      if (tables[table.id] !== table || table.status !== 'in_game') {
        return;
      }

      if (table.game.trickNumber >= 13) {
        finishHand(table);
        return;
      }

      table.game.trickNumber += 1;
      table.game.leaderIndex = winnerIndex;
      table.game.turnIndex = winnerIndex;
      table.game.phase = 'playing';
      emitTableState(table);
      emitHeartsTurn(table);
    }

    if (winner && winner.isBot && BOT_TRICK_PAUSE_MS > 0) {
      setTimeout(advance, BOT_TRICK_PAUSE_MS);
    } else {
      advance();
    }
  }

  function finishHand(table) {
    const result = rules.scoreHandCaptures(table.game.captures);
    const settings = getMatchSettings(table);

    const scoreRows = table.players.map(function (player, index) {
      table.scores[player.name] = (table.scores[player.name] || 0) + result.points[index];
      return { name: player.name, handPoints: result.points[index], totalPoints: table.scores[player.name] };
    });

    const cumulative = table.players.map(function (player) { return table.scores[player.name] || 0; });
    const gameOver = rules.isGameOver(cumulative, settings.pointsToEndGame);
    const shooterName = result.shotTheMoon === null ? null : table.players[result.shotTheMoon].name;

    io.to(table.id).emit('heartsHandSummary', {
      handNumber: table.game.handNumber,
      shotTheMoon: shooterName,
      scores: scoreRows,
      gameOver: gameOver,
      nextDirection: gameOver ? null : rules.getPassDirection(table.game.handNumber + 1)
    });

    if (shooterName) {
      io.to(table.id).emit('actionNotice', shooterName + ' shot the moon! ' + shooterName + ' receives 0 points, everyone else receives 26.');
    }

    if (gameOver) {
      const winnerIndex = rules.getWinnerIndex(cumulative);
      const finalScores = table.players.map(function (player) {
        return { name: player.name, totalPoints: table.scores[player.name] || 0 };
      }).sort(function (a, b) { return a.totalPoints - b.totalPoints; });

      io.to(table.id).emit('heartsGameOver', {
        winner: table.players[winnerIndex].name,
        scores: finalScores
      });
      io.to(table.id).emit('actionNotice', 'Game over. ' + table.players[winnerIndex].name + ' wins with ' + (table.scores[table.players[winnerIndex].name] || 0) + ' points.');

      table.status = 'waiting';
      table.game = null;
      emitTableState(table);
      emitLobbySnapshotAll();
      return;
    }

    table.game.phase = 'hand_complete';
    table.game.pendingHandAcks = {};
    table.players.forEach(function (player) {
      if (!player.isBot) {
        table.game.pendingHandAcks[player.id] = true;
      }
    });

    emitTableState(table);
    tryBeginNextHand(table);
  }

  function tryBeginNextHand(table) {
    if (!table.game || !table.game.pendingHandAcks) {
      return;
    }
    if (Object.keys(table.game.pendingHandAcks).length > 0 || table.status !== 'in_game') {
      return;
    }

    table.game.pendingHandAcks = null;
    beginHand(table);
  }

  function startGame(table) {
    const botSlots = Math.max(0, PLAYER_COUNT - table.players.length);
    addComputerPlayersToTable(table, botSlots, 'random');

    table.status = 'in_game';
    initializeGameState(table);
    beginHand(table);
    return { success: true };
  }

  function buildTableStateExtra(table, socketId) {
    if (!table.game) {
      return { hearts: null };
    }

    const viewerIndex = getPlayerIndex(table, socketId);
    return {
      hearts: {
        handNumber: table.game.handNumber,
        direction: table.game.direction,
        phase: table.game.phase,
        trickNumber: table.game.trickNumber,
        heartsBroken: table.game.heartsBroken,
        trick: buildPublicTrick(table),
        lastTrick: table.game.lastTrick,
        turnPlayerId: table.game.turnIndex !== null && table.players[table.game.turnIndex] ? table.players[table.game.turnIndex].id : null,
        turnPlayerName: table.game.turnIndex !== null && table.players[table.game.turnIndex] ? table.players[table.game.turnIndex].name : '',
        awaitingYourPass: table.game.phase === 'passing' && viewerIndex >= 0 && !table.game.passSelections[viewerIndex]
      }
    };
  }

  function getPlayerSummaryFields(table, player) {
    const index = table.players.indexOf(player);
    const handPoints = table.game && table.game.captures && table.game.captures[index]
      ? table.game.captures[index].reduce(function (sum, card) { return sum + rules.cardPoints(card); }, 0)
      : 0;

    return {
      cardCount: table.status === 'in_game' && table.game ? table.game.hands[index].length : 0,
      score: typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0,
      roundPoints: handPoints
    };
  }

  function onPlayerRemoved(table, removedIndex, playerName) {
    if (table.status !== 'in_game' || !table.game) {
      return;
    }
    // Hearts is fixed at exactly four seats and its state (hands/captures/
    // turn order) is keyed by seat index, so losing a seat mid-hand can't be
    // patched up the way Lumo folds a departed player's cards back into the
    // deck - the fairest simple option is to end the hand/game rather than
    // continue with a broken seat count. The disconnect-grace system (shared,
    // unaffected by this hook) already gives a departing player a window to
    // reconnect into this same seat before this ever runs.
    io.to(table.id).emit('actionNotice', playerName + ' left the game. The Hearts hand cannot continue with fewer than four players.');
  }

  function onPlayerCountSettled(table) {
    if (table.status !== 'in_game') {
      return false;
    }

    table.status = 'waiting';
    table.game = null;
    emitTableState(table);
    emitLobbySnapshotAll();
    return true;
  }

  function onReconnect(table, player, previousSocketId) {
    if (!table.game) {
      return;
    }

    if (table.game.pendingTrickAcks && table.game.pendingTrickAcks[previousSocketId]) {
      table.game.pendingTrickAcks[player.id] = true;
      delete table.game.pendingTrickAcks[previousSocketId];
    }
    if (table.game.pendingHandAcks && table.game.pendingHandAcks[previousSocketId]) {
      table.game.pendingHandAcks[player.id] = true;
      delete table.game.pendingHandAcks[previousSocketId];
    }

    if (table.status !== 'in_game') {
      return;
    }

    const index = getPlayerIndex(table, player.id);
    if (index < 0) {
      return;
    }

    io.to(player.id).emit('heartsHand', {
      hand: table.game.hands[index],
      handNumber: table.game.handNumber,
      direction: table.game.direction,
      phase: table.game.phase
    });

    if (table.game.phase === 'playing' || table.game.phase === 'trick_complete') {
      emitHeartsTurn(table);
    } else if (table.game.phase === 'passing' && !table.game.passSelections[index]) {
      io.to(player.id).emit('heartsPassPrompt', { handNumber: table.game.handNumber, direction: table.game.direction });
    }
  }

  function applyTestState(table, payload) {
    if (!table.game) {
      initializeGameState(table);
    }

    if (payload.game) {
      if (Array.isArray(payload.game.hands)) {
        table.game.hands = payload.game.hands.map(function (hand) { return hand.slice(); });
      }
      if (typeof payload.game.turnIndex === 'number') {
        table.game.turnIndex = payload.game.turnIndex;
      }
      if (typeof payload.game.leaderIndex === 'number') {
        table.game.leaderIndex = payload.game.leaderIndex;
      }
      if (typeof payload.game.trickNumber === 'number') {
        table.game.trickNumber = payload.game.trickNumber;
      }
      if (typeof payload.game.heartsBroken === 'boolean') {
        table.game.heartsBroken = payload.game.heartsBroken;
      }
      if (Array.isArray(payload.game.trick)) {
        table.game.trick = payload.game.trick.slice();
      }
      if (typeof payload.game.phase === 'string') {
        table.game.phase = payload.game.phase;
      }
      if (Array.isArray(payload.game.captures)) {
        table.game.captures = payload.game.captures.map(function (cards) { return cards.slice(); });
      }
    }

    if (payload.emitHeartsTurn) {
      emitHeartsTurn(table);
    }
  }

  function registerSocketHandlers(socket) {
    socket.on('heartsSelectPassCards', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'hearts') {
        return;
      }
      performSelectPassCards(table, socket.id, payload && payload.cards);
    });

    socket.on('heartsPlayCard', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'hearts') {
        return;
      }
      performPlayCard(table, socket.id, payload && payload.card);
    });

    socket.on('heartsAckTrick', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'hearts' || !table.game || !table.game.pendingTrickAcks) {
        return;
      }
      delete table.game.pendingTrickAcks[socket.id];
      tryAdvanceAfterTrick(table);
    });

    socket.on('heartsAckHandSummary', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'hearts' || !table.game || !table.game.pendingHandAcks) {
        return;
      }
      delete table.game.pendingHandAcks[socket.id];
      tryBeginNextHand(table);
    });
  }

  return {
    type: 'hearts',
    name: 'Hearts',
    minPlayers: PLAYER_COUNT,
    maxPlayers: PLAYER_COUNT,
    normalizeMatchSettings: normalizeMatchSettings,
    getMatchSettings: getMatchSettings,
    initializeGameState: initializeGameState,
    startGame: startGame,
    buildTableStateExtra: buildTableStateExtra,
    getPlayerSummaryFields: getPlayerSummaryFields,
    onPlayerRemoved: onPlayerRemoved,
    onPlayerCountSettled: onPlayerCountSettled,
    onReconnect: onReconnect,
    applyTestState: applyTestState,
    registerSocketHandlers: registerSocketHandlers
  };
};
