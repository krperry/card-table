// Spades game module. Wires the pure rules engine (games/spades/rules.js)
// and simple bot heuristics (games/spades/bots.js) into table.game state and
// the Socket.IO events the client drives. Follows the same factory/deps
// shape as games/hearts/index.js - see games/registry.js.
//
// Card play is server-authoritative throughout: every socket handler here
// resolves its own table via deps.findTableBySocket() and re-validates the
// move against rules.getLegalPlays()/rules.getLegalBids() before touching
// any state, exactly like Hearts' performPlayCard(). Event names
// (spadesPlaceBid, spadesPlayResult, etc.) are all unique to this module so
// they can never be delivered to or acted on by a Hearts/Lumo table.
//
// The one structural difference from Hearts: Spades is a fixed-partnership
// team game (seats 0 & 2 vs. seats 1 & 3, see rules.DEFAULT_TEAMS), so
// scoring/game-over operate on two team totals rather than four individual
// ones. table.scores (a generic per-player-name map server.js itself
// initializes on join/bot-add) still stores one number per player, but both
// partners on a team are always kept at the same value - see finishHand()
// below - so the existing generic score plumbing (getPlayerSummaryFields,
// buildTableState) needs no changes to display a team's running total.

const rules = require('./rules');
const bots = require('./bots');

module.exports = function createSpadesGame(deps) {
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
  const MIN_TARGET_SCORE = 100;
  const MAX_TARGET_SCORE = 1000;
  const DEFAULT_TARGET_SCORE = 500;
  const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));
  // Same reasoning as Hearts' BOT_TRICK_PAUSE_MS: gives sighted players a
  // moment to see all four cards on the table before it clears, specifically
  // when a bot won the trick (a bot winner never needs to wait on a human ack
  // the way a human winner's screen naturally does while they read the result).
  const BOT_TRICK_PAUSE_MS = Math.max(0, parseInt(process.env.BOT_TRICK_PAUSE_MS || '2000', 10));

  function normalizeMatchSettings(payload) {
    return {
      targetScore: clampInteger(payload && payload.targetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE)
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
      leaderIndex: null,
      turnIndex: null,
      hands: [[], [], [], []],
      bids: [null, null, null, null],
      spadesBroken: false,
      trick: [],
      trickNumber: 1,
      tricksWon: [0, 0, 0, 0],
      teams: rules.DEFAULT_TEAMS.map(function (seats) { return seats.slice(); }),
      bags: [0, 0],
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

  function sendHands(table) {
    table.players.forEach(function (player, index) {
      io.to(player.id).emit('spadesHand', {
        hand: table.game.hands[index],
        handNumber: table.game.handNumber,
        phase: table.game.phase,
        dealerIndex: table.game.dealerIndex,
        leaderIndex: table.game.leaderIndex
      });
    });
  }

  // Dealer rotates one seat per hand (starting at seat 0 for hand 1), and the
  // seat to the dealer's left both bids first and leads the first trick -
  // standard Spades rule, unlike Hearts' 2-of-Clubs-holder-leads rule.
  function beginHand(table) {
    table.game.handNumber = (table.game.handNumber || 0) + 1;
    table.game.dealerIndex = table.game.handNumber === 1 ? 0 : (table.game.dealerIndex + 1) % PLAYER_COUNT;
    table.game.leaderIndex = (table.game.dealerIndex + 1) % PLAYER_COUNT;

    const deck = rules.createDeck();
    shuffle(deck);
    table.game.hands = rules.deal(deck);
    table.game.bids = [null, null, null, null];
    table.game.spadesBroken = false;
    table.game.trick = [];
    table.game.trickNumber = 1;
    table.game.tricksWon = [0, 0, 0, 0];
    table.game.lastTrick = null;
    table.game.turnIndex = table.game.leaderIndex;
    table.game.phase = 'bidding';

    io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. Bidding begins.');
    sendHands(table);
    emitTableState(table);
    emitSpadesBidState(table, null);
  }

  function describeBid(bid) {
    return bid === 0 ? 'Nil' : String(bid);
  }

  // Mirrors Hearts' buildTurnMessage(): folds "who just bid what" and
  // "your turn" into a single combined announcement per recipient, since two
  // independent srSpeak() calls in the same tick would race the single-slot
  // ARIA live region and silently drop one of them.
  function buildBidMessage(table, recipientIndex, lastBid) {
    const parts = [];
    if (lastBid) {
      if (lastBid.playerIndex !== recipientIndex) {
        parts.push(lastBid.playerName + ' bids ' + describeBid(lastBid.bid) + '.');
      }
    } else if (recipientIndex === table.game.leaderIndex) {
      parts.push('Hand ' + table.game.handNumber + '.');
    }
    if (recipientIndex === table.game.turnIndex) {
      parts.push('Your turn to bid.');
    }
    return parts.length ? parts.join(' ') : null;
  }

  function emitSpadesBidState(table, lastBid) {
    const turnPlayer = table.players[table.game.turnIndex];
    if (!turnPlayer) {
      return;
    }

    table.players.forEach(function (player, index) {
      const payload = {
        phase: 'bidding',
        handNumber: table.game.handNumber,
        dealerIndex: table.game.dealerIndex,
        leaderIndex: table.game.leaderIndex,
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        bids: table.game.bids.slice(),
        message: buildBidMessage(table, index, lastBid)
      };

      if (index === table.game.turnIndex) {
        payload.legalBids = rules.getLegalBids();
      }

      io.to(player.id).emit('spadesBidState', payload);
    });

    maybeScheduleBotTurn(table);
  }

  function maybeScheduleBotTurn(table) {
    if (!table || !table.game || table.status !== 'in_game') {
      return;
    }

    if (table.game.phase === 'bidding') {
      const currentBidder = table.players[table.game.turnIndex];
      if (currentBidder && currentBidder.isBot) {
        scheduleBotAction(table, function () {
          runBotBid(table, currentBidder.id);
        });
      }
      return;
    }

    if (table.game.phase === 'playing') {
      const currentPlayer = table.players[table.game.turnIndex];
      if (currentPlayer && currentPlayer.isBot) {
        scheduleBotAction(table, function () {
          runBotTurn(table, currentPlayer.id);
        });
      }
    }
  }

  function runBotBid(table, botId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'bidding') {
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

    const bid = bots.chooseBotBid(table.game.hands[playerIndex]);
    performPlaceBid(table, botId, bid);
  }

  function performPlaceBid(table, actingId, bid) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'bidding') {
      io.to(actingId).emit('spadesBidResult', { success: false, message: 'Bidding is not open right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('spadesBidResult', { success: false, message: 'It is not your turn to bid' });
      return;
    }

    const numericBid = typeof bid === 'number' ? bid : parseInt(bid, 10);
    if (!rules.isLegalBid(numericBid)) {
      io.to(actingId).emit('spadesBidResult', { success: false, message: 'Bid must be a whole number from 0 (Nil) to 13' });
      return;
    }

    table.game.bids[playerIndex] = numericBid;
    const player = table.players[playerIndex];
    io.to(actingId).emit('spadesBidResult', { success: true, bid: numericBid, message: '' });

    const allBidsIn = table.game.bids.every(function (b) { return b !== null; });
    if (allBidsIn) {
      // The other three players never see a spadesBidState for this final
      // bid (the very next broadcast is emitSpadesTurn(), once bidding is
      // over) - without this, only the bidder themselves would ever learn
      // what the last bid was, via their own spadesBidResult.
      io.to(table.id).emit('actionNotice', player.name + ' bids ' + describeBid(numericBid) + '. Bidding is complete.');
      table.game.phase = 'playing';
      table.game.turnIndex = table.game.leaderIndex;
      emitTableState(table);
      emitSpadesTurn(table);
      return;
    }

    table.game.turnIndex = (playerIndex + 1) % PLAYER_COUNT;
    emitTableState(table);
    emitSpadesBidState(table, { playerIndex: playerIndex, playerName: player.name, bid: numericBid });
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

  function buildTurnMessage(table, recipientIndex, lastPlay) {
    const turnIndex = table.game.turnIndex;

    if (lastPlay) {
      const parts = [];
      if (lastPlay.playerIndex !== recipientIndex) {
        parts.push(lastPlay.playerName + ' plays ' + rules.cardName(lastPlay.card) + '.');
      }
      if (lastPlay.justBroke) {
        parts.push('Spades are now broken.');
      }
      if (recipientIndex === turnIndex) {
        parts.push('Your turn.');
      }
      return parts.length ? parts.join(' ') : null;
    }

    if (table.game.trick.length === 0 && table.game.trickNumber === 1 && recipientIndex === turnIndex) {
      return 'Bidding is done. You lead the first trick.';
    }

    return null;
  }

  function emitSpadesTurn(table, lastPlay) {
    const turnPlayer = table.players[table.game.turnIndex];
    if (!turnPlayer) {
      return;
    }

    table.players.forEach(function (player, index) {
      const payload = {
        phase: 'playing',
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        handNumber: table.game.handNumber,
        trickNumber: table.game.trickNumber,
        spadesBroken: table.game.spadesBroken,
        trick: buildPublicTrick(table),
        message: buildTurnMessage(table, index, lastPlay)
      };

      if (index === table.game.turnIndex) {
        payload.legalCards = rules.getLegalPlays(table.game.hands[index], table.game.trick, table.game.spadesBroken);
      }

      io.to(player.id).emit('spadesTurnState', payload);
    });

    maybeScheduleBotTurn(table);
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

    const card = bots.chooseBotCard(table.game.hands[playerIndex], table.game.trick, table.game.spadesBroken);
    if (card) {
      performPlayCard(table, botId, card);
    }
  }

  function describeRejection(hand, trick, spadesBroken, card) {
    if (trick.length === 0) {
      if (!spadesBroken && rules.isSpade(card)) {
        return 'You cannot lead a Spade until Spades have been broken.';
      }
      return 'You cannot lead that card right now.';
    }

    const ledSuit = rules.suitOf(trick[0].card);
    const sameSuit = hand.filter(function (c) { return rules.suitOf(c) === ledSuit; });
    if (sameSuit.length && rules.suitOf(card) !== ledSuit) {
      return 'You must follow ' + rules.suitName(ledSuit) + '.';
    }

    return 'That card cannot be played right now.';
  }

  function performPlayCard(table, actingId, card) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'playing') {
      io.to(actingId).emit('spadesPlayResult', { success: false, message: 'Unable to play a card right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.turnIndex) {
      io.to(actingId).emit('spadesPlayResult', { success: false, message: 'It is not your turn' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (typeof card !== 'string' || hand.indexOf(card) === -1) {
      io.to(actingId).emit('spadesPlayResult', { success: false, message: 'That card is not in your hand' });
      return;
    }

    const legal = rules.getLegalPlays(hand, table.game.trick, table.game.spadesBroken);
    if (legal.indexOf(card) === -1) {
      const message = describeRejection(hand, table.game.trick, table.game.spadesBroken, card);
      io.to(actingId).emit('spadesPlayResult', { success: false, message: message });
      return;
    }

    hand.splice(hand.indexOf(card), 1);
    table.game.trick.push({ playerIndex: playerIndex, card: card });

    let justBroke = false;
    if (rules.breaksSpades(card) && !table.game.spadesBroken) {
      table.game.spadesBroken = true;
      justBroke = true;
    }

    const player = table.players[playerIndex];
    const trickComplete = table.game.trick.length === PLAYER_COUNT;

    const ownMessage = (justBroke && !trickComplete) ? 'Spades are now broken.' : '';
    io.to(actingId).emit('spadesPlayResult', { success: true, card: card, message: ownMessage });

    io.to(player.id).emit('spadesHand', {
      hand: hand,
      handNumber: table.game.handNumber,
      phase: table.game.phase,
      dealerIndex: table.game.dealerIndex,
      leaderIndex: table.game.leaderIndex
    });

    if (!trickComplete) {
      // Same ordering rule Hearts documents as load-bearing: turnIndex must be
      // advanced before emitTableState() or the client's tableState-driven
      // render briefly shows the player who just moved as still "on turn".
      table.game.turnIndex = (playerIndex + 1) % PLAYER_COUNT;
      emitTableState(table);
      emitSpadesTurn(table, { playerIndex: playerIndex, playerName: player.name, card: card, justBroke: justBroke });
      return;
    }

    const winnerIndex = rules.resolveTrick(table.game.trick);
    table.game.tricksWon[winnerIndex] += 1;
    const winner = table.players[winnerIndex];
    const isFinalTrick = table.game.trickNumber >= 13;

    table.game.lastTrick = { cards: buildPublicTrick(table), winnerId: winner.id, winnerName: winner.name };
    io.to(table.id).emit('spadesTrickResult', {
      trick: table.game.lastTrick.cards,
      winnerId: winner.id,
      winnerName: winner.name,
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
    // (same reasoning as the non-trick-completing branch above) rather than
    // leaving turnIndex on the last-to-act player until acks resolve.
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
      emitSpadesTurn(table);
    }

    if (winner && winner.isBot && BOT_TRICK_PAUSE_MS > 0) {
      setTimeout(advance, BOT_TRICK_PAUSE_MS);
    } else {
      advance();
    }
  }

  function finishHand(table) {
    const settings = getMatchSettings(table);
    const result = rules.scoreHand({
      bids: table.game.bids,
      tricksWon: table.game.tricksWon,
      teams: table.game.teams,
      bagsCarry: table.game.bags
    });
    table.game.bags = result.bags;

    // Both partners on a team are always written to the same total, since
    // Spades scoring is per-team, not per-player - see this module's header
    // comment for why table.scores (a generic per-player-name map) can stay
    // unchanged and still display the right value via getPlayerSummaryFields.
    const teamTotals = table.game.teams.map(function (seats, teamIndex) {
      const currentTotal = table.scores[table.players[seats[0]].name] || 0;
      const newTotal = currentTotal + result.teamPoints[teamIndex];
      seats.forEach(function (seatIndex) {
        table.scores[table.players[seatIndex].name] = newTotal;
      });
      return newTotal;
    });

    const playerRows = table.players.map(function (player, index) {
      const bid = table.game.bids[index];
      return {
        name: player.name,
        bid: bid,
        isNil: bid === 0,
        tricksWon: table.game.tricksWon[index],
        nilMade: bid === 0 ? table.game.tricksWon[index] === 0 : null
      };
    });

    const teamRows = table.game.teams.map(function (seats, teamIndex) {
      return {
        teamIndex: teamIndex,
        playerNames: seats.map(function (seatIndex) { return table.players[seatIndex].name; }),
        handPoints: result.teamPoints[teamIndex],
        bags: result.bags[teamIndex],
        bagPenaltyApplied: result.bagPenaltyApplied[teamIndex],
        contractMade: result.contractMade[teamIndex],
        total: teamTotals[teamIndex]
      };
    });

    const gameOver = rules.isGameOver(teamTotals, settings.targetScore);

    io.to(table.id).emit('spadesHandSummary', {
      handNumber: table.game.handNumber,
      players: playerRows,
      teams: teamRows,
      gameOver: gameOver
    });

    if (gameOver) {
      const winnerTeamIndex = rules.getWinnerTeamIndex(teamTotals);
      const winnerNames = table.game.teams[winnerTeamIndex].map(function (seatIndex) { return table.players[seatIndex].name; });

      io.to(table.id).emit('spadesGameOver', {
        winnerTeamIndex: winnerTeamIndex,
        winnerNames: winnerNames,
        teams: teamRows
      });
      io.to(table.id).emit('actionNotice', 'Game over. ' + winnerNames.join(' & ') + ' win with ' + teamTotals[winnerTeamIndex] + ' points.');

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
      return { spades: null };
    }

    const viewerIndex = getPlayerIndex(table, socketId);
    const turnPlayer = table.game.turnIndex !== null ? table.players[table.game.turnIndex] : null;

    const extra = {
      phase: table.game.phase,
      handNumber: table.game.handNumber,
      dealerIndex: table.game.dealerIndex,
      leaderIndex: table.game.leaderIndex,
      trickNumber: table.game.trickNumber,
      spadesBroken: table.game.spadesBroken,
      trick: buildPublicTrick(table),
      lastTrick: table.game.lastTrick,
      turnPlayerId: turnPlayer ? turnPlayer.id : null,
      turnPlayerName: turnPlayer ? turnPlayer.name : '',
      bids: table.game.bids.slice(),
      tricksWon: table.game.tricksWon.slice(),
      bags: table.game.bags.slice(),
      teams: table.game.teams.map(function (seats) {
        return seats.map(function (seatIndex) {
          const p = table.players[seatIndex];
          return { seatIndex: seatIndex, id: p ? p.id : null, name: p ? p.name : '' };
        });
      })
    };

    if (viewerIndex >= 0 && viewerIndex === table.game.turnIndex) {
      if (table.game.phase === 'bidding') {
        extra.legalBids = rules.getLegalBids();
      } else if (table.game.phase === 'playing') {
        extra.legalCards = rules.getLegalPlays(table.game.hands[viewerIndex], table.game.trick, table.game.spadesBroken);
      }
    }

    return { spades: extra };
  }

  function getPlayerSummaryFields(table, player) {
    const index = table.players.indexOf(player);
    return {
      cardCount: table.status === 'in_game' && table.game ? table.game.hands[index].length : 0,
      score: typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0,
      roundPoints: table.game && table.game.tricksWon ? table.game.tricksWon[index] : 0
    };
  }

  function onPlayerRemoved(table, removedIndex, playerName) {
    if (table.status !== 'in_game' || !table.game) {
      return;
    }
    // Spades is fixed at exactly four seats in two fixed partnerships, and its
    // state (hands/bids/tricksWon/teams/turn order) is keyed by seat index -
    // same reasoning as Hearts' onPlayerRemoved(): losing a seat mid-hand
    // can't be patched up, so the fairest simple option is to end the hand/
    // game rather than continue with a broken seat/partnership. The
    // disconnect-grace system (shared, unaffected by this hook) already gives
    // a departing player a window to reconnect into this same seat first.
    io.to(table.id).emit('actionNotice', playerName + ' left the game. The Spades hand cannot continue with fewer than four players.');
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

    io.to(player.id).emit('spadesHand', {
      hand: table.game.hands[index],
      handNumber: table.game.handNumber,
      phase: table.game.phase,
      dealerIndex: table.game.dealerIndex,
      leaderIndex: table.game.leaderIndex
    });

    if (table.game.phase === 'playing' || table.game.phase === 'trick_complete') {
      emitSpadesTurn(table);
    } else if (table.game.phase === 'bidding') {
      emitSpadesBidState(table, null);
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
      if (typeof payload.game.dealerIndex === 'number') {
        table.game.dealerIndex = payload.game.dealerIndex;
      }
      if (typeof payload.game.trickNumber === 'number') {
        table.game.trickNumber = payload.game.trickNumber;
      }
      if (typeof payload.game.spadesBroken === 'boolean') {
        table.game.spadesBroken = payload.game.spadesBroken;
      }
      if (Array.isArray(payload.game.trick)) {
        table.game.trick = payload.game.trick.slice();
      }
      if (typeof payload.game.phase === 'string') {
        table.game.phase = payload.game.phase;
      }
      if (Array.isArray(payload.game.bids)) {
        table.game.bids = payload.game.bids.slice();
      }
      if (Array.isArray(payload.game.tricksWon)) {
        table.game.tricksWon = payload.game.tricksWon.slice();
      }
      if (Array.isArray(payload.game.bags)) {
        table.game.bags = payload.game.bags.slice();
      }
    }

    if (payload.emitSpadesTurn) {
      emitSpadesTurn(table);
    }
    if (payload.emitSpadesBidState) {
      emitSpadesBidState(table, null);
    }
  }

  function registerSocketHandlers(socket) {
    socket.on('spadesPlaceBid', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'spades') {
        return;
      }
      performPlaceBid(table, socket.id, payload && payload.bid);
    });

    socket.on('spadesPlayCard', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'spades') {
        return;
      }
      performPlayCard(table, socket.id, payload && payload.card);
    });

    socket.on('spadesAckTrick', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'spades' || !table.game || !table.game.pendingTrickAcks) {
        return;
      }
      delete table.game.pendingTrickAcks[socket.id];
      tryAdvanceAfterTrick(table);
    });

    socket.on('spadesAckHandSummary', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'spades' || !table.game || !table.game.pendingHandAcks) {
        return;
      }
      delete table.game.pendingHandAcks[socket.id];
      tryBeginNextHand(table);
    });
  }

  return {
    type: 'spades',
    name: 'Spades',
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
