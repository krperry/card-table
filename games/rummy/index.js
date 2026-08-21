// Rummy game module. Wires the pure rules engine (games/rummy/rules.js) and
// simple bot heuristics (games/rummy/bots.js) into table.game state and the
// Socket.IO events the client drives. Follows the same factory/deps shape as
// games/hearts/index.js, games/spades/index.js, and games/cribbage/index.js -
// see games/registry.js.
//
// Card play is server-authoritative throughout: every socket handler here
// resolves its own table via deps.findTableBySocket() and re-validates the
// move against the rules engine before touching any state. Event names
// (rummyDrawStock, rummyMeldCards, etc.) are all unique to this module so
// they can never be delivered to or acted on by a Hearts/Spades/Cribbage/Lumo
// table.
//
// Two structural differences from the fixed-seat-count games (Hearts/Spades/
// Cribbage all always pad to a fixed PLAYER_COUNT):
//   1. Rummy seats 2-6 players. startGame() only pads a lone human up to 2 -
//      a 3-6 human table starts as-is, with no forced top-up beyond that.
//   2. Melds are the one interaction the platform has never needed before:
//      face-up groups every player can see and lay cards off onto (even
//      their own). table.game.melds[seatIndex] is an array of
//      { type: 'set'|'run', cards: [...] } groups. Lay-offs never ask the
//      client to name a specific group - performLayOffCards() auto-resolves
//      which group a marked card attaches to via rules.canExtendMeld(), the
//      same simplification the client's "press 1-6, then L" keyboard flow
//      relies on (see public/games/rummy/rummy-client.js).
//
// Turn structure: turnPhase 'draw' (must call rummyDrawStock/rummyDrawDiscard
// before anything else) -> 'action' (any number of rummyMeldCards/
// rummyLayOffCards calls) -> a rummyDiscardCard call ends the turn and
// advances turnIndex back to 'draw' for the next seat. There is no
// legalCards-style pre-filtered move list the way Hearts/Spades expose (any
// card may be discarded on your turn; any set/run combination may be
// attempted) - every action is validated reactively, purely server-side.

const rules = require('./rules');
const bots = require('./bots');

module.exports = function createRummyGame(deps) {
  const io = deps.io;
  const tables = deps.tables;
  const shuffle = deps.shuffle;
  const getPlayerIndex = deps.getPlayerIndex;
  const clampInteger = deps.clampInteger;
  const emitTableState = deps.emitTableState;
  const emitLobbySnapshotAll = deps.emitLobbySnapshotAll;
  const addComputerPlayersToTable = deps.addComputerPlayersToTable;
  const findTableBySocket = deps.findTableBySocket;
  const recordGameResult = deps.recordGameResult;

  const MIN_TARGET_SCORE = 100;
  const MAX_TARGET_SCORE = 1000;
  const DEFAULT_TARGET_SCORE = 500;
  const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));

  function normalizeMatchSettings(payload) {
    return {
      targetScore: clampInteger(payload && payload.rummyTargetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE)
    };
  }

  function getMatchSettings(table) {
    const matchSettings = table && table.matchSettings ? table.matchSettings : {};
    return {
      targetScore: clampInteger(matchSettings.targetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE)
    };
  }

  function initializeGameState(table) {
    table.game = {
      handNumber: 0,
      phase: 'waiting',
      dealerIndex: null,
      turnIndex: null,
      turnPhase: 'draw',
      hands: table.players.map(function () { return []; }),
      stock: [],
      discardPile: [],
      melds: table.players.map(function () { return []; }),
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

  function sendHand(table, player, index) {
    io.to(player.id).emit('rummyHand', {
      hand: table.game.hands[index],
      handNumber: table.game.handNumber,
      phase: table.game.phase,
      dealerIndex: table.game.dealerIndex
    });
  }

  function sendHands(table) {
    table.players.forEach(function (player, index) {
      sendHand(table, player, index);
    });
  }

  function cardsAllInHand(hand, cards) {
    const pool = hand.slice();
    for (let i = 0; i < cards.length; i++) {
      const idx = pool.indexOf(cards[i]);
      if (idx === -1) {
        return false;
      }
      pool.splice(idx, 1);
    }
    return true;
  }

  // Dealer rotates one seat per hand (starting at seat 0 for hand 1), and the
  // seat to the dealer's left draws first - the standard Rummy turn order.
  function beginHand(table) {
    const playerCount = table.players.length;
    table.game.handNumber = (table.game.handNumber || 0) + 1;
    table.game.dealerIndex = table.game.handNumber === 1 ? 0 : (table.game.dealerIndex + 1) % playerCount;
    table.game.turnIndex = (table.game.dealerIndex + 1) % playerCount;

    const deck = rules.createDeck();
    shuffle(deck);
    const dealt = rules.deal(deck, playerCount);
    table.game.hands = dealt.hands;
    table.game.stock = dealt.stock;
    table.game.discardPile = dealt.discard;
    table.game.melds = table.players.map(function () { return []; });
    table.game.turnPhase = 'draw';
    table.game.phase = 'playing';

    io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. ' + table.players[table.game.turnIndex].name + ' draws first.');
    sendHands(table);
    emitTableState(table);
    emitRummyTurnState(table, null);
  }

  function buildTurnMessage(table, recipientIndex, lastEvent) {
    const parts = [];
    if (lastEvent) {
      if (lastEvent.type === 'draw' && lastEvent.playerIndex !== recipientIndex) {
        // The stock is face-down - naming the card would leak hidden
        // information other players aren't supposed to have. The discard
        // pile is face-up, so that card is fair to announce (everyone could
        // already see it sitting on top of the pile).
        if (lastEvent.source === 'discard') {
          parts.push(lastEvent.playerName + ' takes the ' + rules.cardName(lastEvent.card) + ' from the discard pile.');
        } else {
          parts.push(lastEvent.playerName + ' draws from the stack.');
        }
      } else if (lastEvent.type === 'meld' && lastEvent.playerIndex !== recipientIndex) {
        parts.push(lastEvent.playerName + ' melds a ' + lastEvent.meldType + '.');
      } else if (lastEvent.type === 'layoff' && lastEvent.playerIndex !== recipientIndex) {
        const count = lastEvent.cards.length;
        parts.push(lastEvent.playerName + ' lays off ' + count + ' card' + (count === 1 ? '' : 's') + '.');
      } else if (lastEvent.type === 'discard' && lastEvent.playerIndex !== recipientIndex) {
        parts.push(lastEvent.playerName + ' discards ' + rules.cardName(lastEvent.card) + '.');
      }
    }
    // Only announce whose turn it is at the start of a fresh turn (turnPhase
    // 'draw') - not on every meld/lay-off call within the SAME player's
    // still-ongoing turn, which would otherwise repeat "Your turn." after
    // each of their own sub-actions. Firing this for every recipient (not
    // just the player whose turn it now is) lets a blind player who isn't
    // up next still hear who they're waiting on.
    if (table.game.turnPhase === 'draw') {
      parts.push(recipientIndex === table.game.turnIndex
        ? 'It is your turn.'
        : 'It is ' + table.players[table.game.turnIndex].name + '\'s turn.');
    }
    return parts.length ? parts.join(' ') : null;
  }

  function emitRummyTurnState(table, lastEvent) {
    const turnPlayer = table.players[table.game.turnIndex];
    if (!turnPlayer) {
      return;
    }
    const discardTop = table.game.discardPile.length ? table.game.discardPile[table.game.discardPile.length - 1] : null;

    table.players.forEach(function (player, index) {
      io.to(player.id).emit('rummyTurnState', {
        phase: table.game.phase,
        handNumber: table.game.handNumber,
        dealerIndex: table.game.dealerIndex,
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        turnPhase: table.game.turnPhase,
        stockCount: table.game.stock.length,
        discardTop: discardTop,
        melds: table.game.melds,
        message: buildTurnMessage(table, index, lastEvent)
      });
    });

    maybeScheduleBotTurn(table);
  }

  // Only fires at the start of a fresh turn (turnPhase 'draw') - a bot's own
  // draw->meld/layoff->discard sequence runs synchronously in one go inside
  // runBotTurn() below, so there is no separate scheduling point mid-turn.
  function maybeScheduleBotTurn(table) {
    if (!table || !table.game || table.status !== 'in_game' || table.game.phase !== 'playing') {
      return;
    }
    if (table.game.turnPhase !== 'draw') {
      return;
    }
    const currentPlayer = table.players[table.game.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
      scheduleBotAction(table, function () {
        runBotTurn(table, currentPlayer.id);
      });
    }
  }

  function stillBotsTurn(table, playerIndex) {
    return !!(table.game && table.game.phase === 'playing' && table.game.turnIndex === playerIndex);
  }

  function runBotTurn(table, botId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      return;
    }
    const playerIndex = getPlayerIndex(table, botId);
    if (playerIndex !== table.game.turnIndex || table.game.turnPhase !== 'draw') {
      return;
    }
    const bot = table.players[playerIndex];
    if (!bot || !bot.isBot) {
      return;
    }

    const topDiscard = table.game.discardPile.length ? table.game.discardPile[table.game.discardPile.length - 1] : null;
    const source = bots.chooseDrawSource(table.game.hands[playerIndex], topDiscard);
    if (source === 'discard' && topDiscard) {
      performDrawDiscard(table, botId);
    } else {
      performDrawStock(table, botId);
    }
    if (!stillBotsTurn(table, playerIndex)) {
      return;
    }

    const decision = bots.chooseMeldsAndLayoffs(table.game.hands[playerIndex], table.game.melds);
    for (let i = 0; i < decision.melds.length; i++) {
      if (!stillBotsTurn(table, playerIndex)) {
        return;
      }
      performMeldCards(table, botId, decision.melds[i]);
    }
    if (!stillBotsTurn(table, playerIndex)) {
      return;
    }
    for (let i = 0; i < decision.layoffs.length; i++) {
      if (!stillBotsTurn(table, playerIndex)) {
        return;
      }
      performLayOffCards(table, botId, decision.layoffs[i].targetPlayerIndex, decision.layoffs[i].cards);
    }
    if (!stillBotsTurn(table, playerIndex)) {
      return;
    }

    const discardCard = bots.chooseDiscard(table.game.hands[playerIndex]);
    if (discardCard) {
      performDiscardCard(table, botId, discardCard);
    }
  }

  function performDrawStock(table, actingId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'Unable to draw right now' });
      return;
    }
    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'It is not your turn' });
      return;
    }
    if (table.game.turnPhase !== 'draw') {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'You have already drawn this turn' });
      return;
    }

    if (rules.isStockExhausted(table.game.stock)) {
      const reshuffled = rules.reshuffleDiscardIntoStock(table.game.discardPile);
      if (!reshuffled.stock.length) {
        // Double-exhaustion: the discard pile itself has nothing left beyond
        // its own top card to reshuffle. Extremely rare - documented
        // fallback (see public/rummy-rules.md): end the hand with no winner
        // and no score change.
        endHandNoWinner(table, 'The stock and discard pile are both exhausted. This hand ends with no winner.');
        return;
      }
      shuffle(reshuffled.stock);
      table.game.stock = reshuffled.stock;
      table.game.discardPile = reshuffled.discard;
      io.to(table.id).emit('actionNotice', 'The stock ran out. The discard pile has been reshuffled into a new stock.');
    }

    const card = table.game.stock.pop();
    const hand = table.game.hands[playerIndex];
    hand.push(card);
    table.game.turnPhase = 'action';

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyDrawResult', { success: true, card: card, source: 'stock', message: '' });
    sendHand(table, player, playerIndex);

    emitTableState(table);
    emitRummyTurnState(table, { type: 'draw', playerIndex: playerIndex, playerName: player.name, source: 'stock' });
  }

  function performDrawDiscard(table, actingId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'Unable to draw right now' });
      return;
    }
    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'It is not your turn' });
      return;
    }
    if (table.game.turnPhase !== 'draw') {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'You have already drawn this turn' });
      return;
    }
    if (!table.game.discardPile.length) {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'The discard pile is empty' });
      return;
    }

    const card = table.game.discardPile.pop();
    const hand = table.game.hands[playerIndex];
    hand.push(card);
    table.game.turnPhase = 'action';

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyDrawResult', { success: true, card: card, source: 'discard', message: '' });
    sendHand(table, player, playerIndex);

    emitTableState(table);
    emitRummyTurnState(table, { type: 'draw', playerIndex: playerIndex, playerName: player.name, source: 'discard', card: card });
  }

  function performMeldCards(table, actingId, cards) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: 'Unable to meld right now' });
      return;
    }
    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: 'It is not your turn' });
      return;
    }
    if (table.game.turnPhase !== 'action') {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: 'Draw a card before melding' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (!Array.isArray(cards) || !cards.length || !cardsAllInHand(hand, cards)) {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: 'Select cards from your own hand' });
      return;
    }

    const classification = rules.classifyMeld(cards);
    if (!classification.valid) {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: 'Those cards do not form a valid set or run' });
      return;
    }

    cards.forEach(function (card) {
      hand.splice(hand.indexOf(card), 1);
    });
    table.game.melds[playerIndex].push({ type: classification.type, cards: cards.slice() });

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyMeldResult', { success: true, message: '' });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    emitTableState(table);
    emitRummyTurnState(table, { type: 'meld', playerIndex: playerIndex, playerName: player.name, meldType: classification.type });
  }

  function performLayOffCards(table, actingId, targetPlayerIndex, cards) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: 'Unable to lay off right now' });
      return;
    }
    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: 'It is not your turn' });
      return;
    }
    if (table.game.turnPhase !== 'action') {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: 'Draw a card before laying off' });
      return;
    }

    const targetIndex = typeof targetPlayerIndex === 'number' ? targetPlayerIndex : parseInt(targetPlayerIndex, 10);
    const targetGroups = table.game.melds[targetIndex];
    if (!Array.isArray(targetGroups)) {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: 'That is not a valid player to lay off onto' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (!Array.isArray(cards) || !cards.length || !cardsAllInHand(hand, cards)) {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: 'Select cards from your own hand' });
      return;
    }

    // Simulate against a deep copy first so the whole batch either lands or
    // rejects together - never partially apply. A screen-reader user needs a
    // single clear reason for a rejected batch, not a half-applied one.
    const simulatedGroups = targetGroups.map(function (group) { return { type: group.type, cards: group.cards.slice() }; });
    const assignments = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      let attachedGroupIndex = -1;
      for (let g = 0; g < simulatedGroups.length; g++) {
        if (rules.canExtendMeld(simulatedGroups[g], card)) {
          attachedGroupIndex = g;
          break;
        }
      }
      if (attachedGroupIndex === -1) {
        io.to(actingId).emit('rummyLayOffResult', { success: false, message: rules.cardName(card) + ' cannot be laid off onto that player’s melds' });
        return;
      }
      simulatedGroups[attachedGroupIndex].cards.push(card);
      assignments.push(attachedGroupIndex);
    }

    cards.forEach(function (card, i) {
      hand.splice(hand.indexOf(card), 1);
      targetGroups[assignments[i]].cards.push(card);
    });

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyLayOffResult', { success: true, message: '' });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    emitTableState(table);
    emitRummyTurnState(table, { type: 'layoff', playerIndex: playerIndex, playerName: player.name, cards: cards });
  }

  function performDiscardCard(table, actingId, card) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('rummyDiscardResult', { success: false, message: 'Unable to discard right now' });
      return;
    }
    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('rummyDiscardResult', { success: false, message: 'It is not your turn' });
      return;
    }
    if (table.game.turnPhase !== 'action') {
      io.to(actingId).emit('rummyDiscardResult', { success: false, message: 'Draw a card before discarding' });
      return;
    }
    const hand = table.game.hands[playerIndex];
    if (typeof card !== 'string' || hand.indexOf(card) === -1) {
      io.to(actingId).emit('rummyDiscardResult', { success: false, message: 'That card is not in your hand' });
      return;
    }

    hand.splice(hand.indexOf(card), 1);
    table.game.discardPile.push(card);

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyDiscardResult', { success: true, card: card, message: '' });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    table.game.turnIndex = (playerIndex + 1) % table.players.length;
    table.game.turnPhase = 'draw';

    emitTableState(table);
    emitRummyTurnState(table, { type: 'discard', playerIndex: playerIndex, playerName: player.name, card: card });
  }

  function finishHand(table, wentOutPlayerIndex) {
    const settings = getMatchSettings(table);
    const result = rules.scoreHand(table.game.hands, wentOutPlayerIndex);

    table.players.forEach(function (player, index) {
      table.scores[player.name] = (table.scores[player.name] || 0) + result.pointsAwarded[index];
    });

    const cumulativeScores = table.players.map(function (player) { return table.scores[player.name] || 0; });
    const wentOutPlayer = table.players[wentOutPlayerIndex];

    const rows = table.players.map(function (player, index) {
      return {
        name: player.name,
        deadwood: result.deadwoodByPlayer[index],
        pointsAwarded: result.pointsAwarded[index],
        total: cumulativeScores[index]
      };
    });

    const gameOver = rules.isGameOver(cumulativeScores, settings.targetScore);

    io.to(table.id).emit('rummyHandSummary', {
      handNumber: table.game.handNumber,
      wentOutPlayerName: wentOutPlayer.name,
      noWinner: false,
      rows: rows,
      gameOver: gameOver
    });
    io.to(table.id).emit('actionNotice', wentOutPlayer.name + ' goes out. Hand ' + table.game.handNumber + ' complete.');

    if (gameOver) {
      const winnerIndex = rules.getWinnerIndex(cumulativeScores);
      const winner = table.players[winnerIndex];
      const finalScores = table.players.map(function (player) {
        return { name: player.name, totalPoints: table.scores[player.name] || 0 };
      });

      io.to(table.id).emit('rummyGameOver', { winnerName: winner.name, scores: finalScores });
      io.to(table.id).emit('actionNotice', 'Game over. ' + winner.name + ' wins with ' + (table.scores[winner.name] || 0) + ' points.');

      table.players.forEach(function (player, index) {
        recordGameResult(player.accountId, 'rummy', index === winnerIndex ? 'win' : 'loss');
      });

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

  function endHandNoWinner(table, message) {
    io.to(table.id).emit('rummyHandSummary', {
      handNumber: table.game.handNumber,
      wentOutPlayerName: null,
      noWinner: true,
      rows: table.players.map(function (player, index) {
        return {
          name: player.name,
          deadwood: table.game.hands[index].reduce(function (sum, c) { return sum + rules.cardValue(c); }, 0),
          pointsAwarded: 0,
          total: table.scores[player.name] || 0
        };
      }),
      gameOver: false
    });
    io.to(table.id).emit('actionNotice', message);

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

  // Rummy's variable 2-6 player count means it can't follow Hearts/Spades/
  // Cribbage's "always pad to a fixed PLAYER_COUNT" pattern - a 3-6 human
  // table starts as-is. Only the single-human case needs a bot, to make a
  // legal 2-player game.
  function startGame(table) {
    if (table.players.length === 1) {
      addComputerPlayersToTable(table, 1, 'random');
    }

    table.status = 'in_game';
    initializeGameState(table);
    beginHand(table);
    return { success: true };
  }

  function buildTableStateExtra(table) {
    if (!table.game) {
      return { rummy: null };
    }

    const turnPlayer = table.game.turnIndex !== null ? table.players[table.game.turnIndex] : null;
    const discardTop = table.game.discardPile.length ? table.game.discardPile[table.game.discardPile.length - 1] : null;

    return {
      rummy: {
        phase: table.game.phase,
        handNumber: table.game.handNumber,
        dealerIndex: table.game.dealerIndex,
        turnIndex: table.game.turnIndex,
        turnPlayerId: turnPlayer ? turnPlayer.id : null,
        turnPlayerName: turnPlayer ? turnPlayer.name : '',
        turnPhase: table.game.turnPhase,
        stock: { count: table.game.stock.length },
        discardPile: { top: discardTop, count: table.game.discardPile.length },
        // Melds are public by design (every player can see every meld on the
        // table) so it is always safe to include the full structure here,
        // unlike hands.
        melds: table.game.melds
      }
    };
  }

  function getPlayerSummaryFields(table, player) {
    const index = table.players.indexOf(player);
    return {
      cardCount: table.status === 'in_game' && table.game && table.game.hands[index] ? table.game.hands[index].length : 0,
      score: typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0
    };
  }

  function onPlayerRemoved(table, removedIndex, playerName) {
    if (table.status !== 'in_game' || !table.game) {
      return;
    }
    // Rummy's state (hands/melds/turnIndex) is keyed by seat index, same
    // reasoning as Hearts'/Spades'/Cribbage's onPlayerRemoved(): losing a
    // seat mid-hand can't be patched up, so the fairest simple option is to
    // end the hand/table rather than continue with a broken seat. The
    // disconnect-grace system (shared, unaffected by this hook) already
    // gives a departing player a window to reconnect into this same seat.
    io.to(table.id).emit('actionNotice', playerName + ' left the game. This Rummy hand cannot continue without them.');
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

    sendHand(table, player, index);

    if (table.game.phase === 'playing') {
      emitRummyTurnState(table, null);
    }
  }

  function applyTestState(table, payload) {
    if (!table.game) {
      initializeGameState(table);
    }

    if (payload.game) {
      const g = payload.game;
      if (Array.isArray(g.hands)) {
        table.game.hands = g.hands.map(function (hand) { return hand.slice(); });
      }
      if (Array.isArray(g.stock)) {
        table.game.stock = g.stock.slice();
      }
      if (Array.isArray(g.discardPile)) {
        table.game.discardPile = g.discardPile.slice();
      }
      if (Array.isArray(g.melds)) {
        table.game.melds = g.melds.map(function (seatGroups) {
          return (seatGroups || []).map(function (group) {
            return { type: group.type, cards: group.cards.slice() };
          });
        });
      }
      if (typeof g.turnIndex === 'number') {
        table.game.turnIndex = g.turnIndex;
      }
      if (typeof g.turnPhase === 'string') {
        table.game.turnPhase = g.turnPhase;
      }
      if (typeof g.dealerIndex === 'number') {
        table.game.dealerIndex = g.dealerIndex;
      }
      if (typeof g.phase === 'string') {
        table.game.phase = g.phase;
      }
      if (typeof g.handNumber === 'number') {
        table.game.handNumber = g.handNumber;
      }
    }

    if (payload.emitRummyTurnState) {
      emitRummyTurnState(table, null);
    }
  }

  function registerSocketHandlers(socket) {
    socket.on('rummyDrawStock', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performDrawStock(table, socket.id);
    });

    socket.on('rummyDrawDiscard', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performDrawDiscard(table, socket.id);
    });

    socket.on('rummyMeldCards', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performMeldCards(table, socket.id, payload && payload.cards);
    });

    socket.on('rummyLayOffCards', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performLayOffCards(table, socket.id, payload && payload.targetPlayerIndex, payload && payload.cards);
    });

    socket.on('rummyDiscardCard', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performDiscardCard(table, socket.id, payload && payload.card);
    });

    socket.on('rummyAckHandSummary', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy' || !table.game || !table.game.pendingHandAcks) {
        return;
      }
      delete table.game.pendingHandAcks[socket.id];
      tryBeginNextHand(table);
    });
  }

  return {
    type: 'rummy',
    name: 'Rummy',
    minPlayers: 2,
    maxPlayers: 6,
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
