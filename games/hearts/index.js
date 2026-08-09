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

  function sendHands(table) {
    table.players.forEach(function (player, index) {
      io.to(player.id).emit('heartsHand', {
        hand: table.game.hands[index],
        handNumber: table.game.handNumber,
        direction: table.game.direction,
        phase: table.game.phase
      });
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
      table.game.phase = 'playing';
      sendHands(table);
      emitTableState(table);
      startPlayPhase(table);
      io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. Hold - no cards will be passed.');
      return;
    }

    table.game.phase = 'passing';
    sendHands(table);
    io.to(table.id).emit('heartsPassPrompt', { handNumber: table.game.handNumber, direction: direction });
    io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. Pass three cards to the ' + direction + '.');
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
    io.to(actingId).emit('heartsPassResult', { success: true, message: 'Pass submitted. Waiting for other players.' });
    emitTableState(table);
    maybeResolvePassing(table);
  }

  function maybeResolvePassing(table) {
    if (table.game.passSelections.some(function (selection) { return !selection; })) {
      return;
    }

    table.game.hands = rules.applyPass(table.game.hands, table.game.passSelections, table.game.direction);
    table.game.passSelections = [null, null, null, null];
    sendHands(table);
    io.to(table.id).emit('actionNotice', 'You received three cards.');
    startPlayPhase(table);
  }

  function startPlayPhase(table) {
    const leaderIndex = rules.findTwoOfClubsHolder(table.game.hands);
    table.game.leaderIndex = leaderIndex;
    table.game.turnIndex = leaderIndex;
    table.game.phase = 'playing';
    emitTableState(table);
    emitHeartsTurn(table);
    maybeScheduleBotTurn(table);
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

  function emitHeartsTurn(table) {
    const turnPlayer = table.players[table.game.turnIndex];
    if (!turnPlayer) {
      return;
    }

    const isFirstTrick = table.game.trickNumber === 1;
    const ledSuit = table.game.trick.length ? rules.suitOf(table.game.trick[0].card) : null;

    table.players.forEach(function (player, index) {
      const payload = {
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        handNumber: table.game.handNumber,
        trickNumber: table.game.trickNumber,
        heartsBroken: table.game.heartsBroken,
        ledSuit: ledSuit,
        ledSuitName: ledSuit ? rules.suitName(ledSuit) : null,
        trick: buildPublicTrick(table)
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

  function describeRejection(hand, trick, heartsBroken, isFirstTrick, card) {
    if (trick.length === 0 && isFirstTrick) {
      return 'The first trick must begin with the 2 of Clubs.';
    }

    if (trick.length === 0) {
      if (!heartsBroken && rules.isHeart(card)) {
        return 'Hearts have not been broken.';
      }
      return 'You cannot lead that card right now.';
    }

    const ledSuit = rules.suitOf(trick[0].card);
    const sameSuit = hand.filter(function (c) { return rules.suitOf(c) === ledSuit; });
    if (sameSuit.length && rules.suitOf(card) !== ledSuit) {
      return 'Play rejected. You must follow ' + rules.suitName(ledSuit) + '.';
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
      const message = 'Play rejected. ' + describeRejection(hand, table.game.trick, table.game.heartsBroken, isFirstTrick, card);
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
    io.to(actingId).emit('heartsPlayResult', { success: true, card: card, message: 'You play ' + rules.cardName(card) + '.' });
    const breakSuffix = justBroke ? ' Hearts are now broken.' : '';
    io.to(table.id).emit('actionNotice', player.name + ' played ' + rules.cardName(card) + '.' + breakSuffix);

    io.to(player.id).emit('heartsHand', {
      hand: hand,
      handNumber: table.game.handNumber,
      direction: table.game.direction,
      phase: table.game.phase
    });
    emitTableState(table);

    if (table.game.trick.length < PLAYER_COUNT) {
      table.game.turnIndex = (playerIndex + 1) % PLAYER_COUNT;
      emitHeartsTurn(table);
      return;
    }

    const winnerIndex = rules.resolveTrick(table.game.trick);
    const trickCards = table.game.trick.map(function (entry) { return entry.card; });
    table.game.captures[winnerIndex] = table.game.captures[winnerIndex].concat(trickCards);
    const trickPoints = trickCards.reduce(function (sum, c) { return sum + rules.cardPoints(c); }, 0);
    const winner = table.players[winnerIndex];

    table.game.lastTrick = { cards: buildPublicTrick(table), winnerId: winner.id, winnerName: winner.name };
    io.to(table.id).emit('heartsTrickResult', {
      trick: table.game.lastTrick.cards,
      winnerId: winner.id,
      winnerName: winner.name,
      points: trickPoints,
      trickNumber: table.game.trickNumber
    });
    io.to(table.id).emit('actionNotice', 'Trick complete. ' + winner.name + ' wins the trick' + (trickPoints > 0 ? ' and takes ' + trickPoints + ' point' + (trickPoints === 1 ? '' : 's') + '.' : '.'));

    table.game.trick = [];
    table.game.phase = 'trick_complete';
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
