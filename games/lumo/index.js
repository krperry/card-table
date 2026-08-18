// Lumo (UNO-like) game module. All Lumo-specific rules, deck/card model, bot
// decisions, and round/match lifecycle live here - moved out of server.js as
// part of splitting the platform into per-game modules (see games/registry.js).
//
// This module is a factory: server.js calls createLumoGame(deps) once at
// startup with a small object of shared table/networking primitives
// (io, tables, shuffle, normalizeIndex, getPlayerIndex, clampInteger,
// emitTableState, emitLobbySnapshotAll, addComputerPlayersToTable,
// findTableBySocket) and gets back the game-module interface consumed by
// server.js's generic dispatchers (buildTableState, the startGame handler,
// removePlayerFromTable, reclaimSeatAfterReconnect, __testSetTableState).

module.exports = function createLumoGame(deps) {
  const io = deps.io;
  const tables = deps.tables;
  const shuffle = deps.shuffle;
  const normalizeIndexShared = deps.normalizeIndex;
  const getPlayerIndex = deps.getPlayerIndex;
  const clampInteger = deps.clampInteger;
  const emitTableState = deps.emitTableState;
  const emitLobbySnapshotAll = deps.emitLobbySnapshotAll;
  const addComputerPlayersToTable = deps.addComputerPlayersToTable;
  const recordGameResult = deps.recordGameResult;

  const MAX_PLAYERS = 6;
  const MIN_PLAYERS = 2;
  const MATCH_POINTS_TO_WIN = 500;
  const DEFAULT_MAX_ROUNDS = 30;
  const MIN_WINNING_SCORE = 50;
  const MAX_WINNING_SCORE = 100000;
  const MIN_MAX_ROUNDS = 1;
  const MAX_MAX_ROUNDS = 1000;
  const MAX_COMPUTER_PLAYERS = 5;
  const COMPUTER_SKILL_LEVELS = ['random', '1', '2', '3'];
  const DEFAULT_COMPUTER_SKILL = 'random';
  const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));

  // Give Plus One cards live in their own ID range (GIVE_PLUS_ONE_BASE..+3, one per
  // color) so the existing color*14+value scheme used for numbered/action cards does
  // not need to be renumbered. isGivePlusOneCard()/COLOR_NAMES below decode it.
  const GIVE_PLUS_ONE_BASE = 1000;
  const COLOR_NAMES = ['red', 'yellow', 'green', 'blue'];

  function normalizeComputerSkill(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return COMPUTER_SKILL_LEVELS.indexOf(normalized) !== -1 ? normalized : DEFAULT_COMPUTER_SKILL;
  }

  function normalizeMatchSettings(payload) {
    return {
      winningScore: clampInteger(payload && payload.winningScore, MIN_WINNING_SCORE, MAX_WINNING_SCORE, MATCH_POINTS_TO_WIN),
      maxRounds: clampInteger(payload && payload.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
      allowDrawTwoStacking: !!(payload && payload.allowDrawTwoStacking),
      allowWildDrawFourStacking: !!(payload && payload.allowWildDrawFourStacking),
      computerPlayers: clampInteger(payload && payload.computerPlayers, 0, MAX_COMPUTER_PLAYERS, 0),
      computerSkill: normalizeComputerSkill(payload && payload.computerSkill)
    };
  }

  function getMatchSettings(table) {
    const matchSettings = table && table.matchSettings ? table.matchSettings : {};

    return {
      winningScore: clampInteger(matchSettings.winningScore, MIN_WINNING_SCORE, MAX_WINNING_SCORE, MATCH_POINTS_TO_WIN),
      maxRounds: clampInteger(matchSettings.maxRounds, MIN_MAX_ROUNDS, MAX_MAX_ROUNDS, DEFAULT_MAX_ROUNDS),
      allowDrawTwoStacking: !!matchSettings.allowDrawTwoStacking,
      allowWildDrawFourStacking: !!matchSettings.allowWildDrawFourStacking,
      computerPlayers: clampInteger(matchSettings.computerPlayers, 0, MAX_COMPUTER_PLAYERS, 0),
      computerSkill: normalizeComputerSkill(matchSettings.computerSkill)
    };
  }

  function getNextPlayerIndex(table, currentIndex, steps) {
    const direction = table.game && table.game.reverse ? -1 : 1;
    return normalizeIndexShared(currentIndex + steps * direction, table.players.length);
  }

  function isGivePlusOneCard(card) {
    return typeof card === 'number' && card >= GIVE_PLUS_ONE_BASE && card < GIVE_PLUS_ONE_BASE + COLOR_NAMES.length;
  }

  function createDeck() {
    const deck = [];
    for (let color = 0; color < 4; color++) {
      deck.push(color * 14 + 0);
      for (let value = 1; value <= 12; value++) {
        deck.push(color * 14 + value);
        deck.push(color * 14 + value);
      }
    }

    // Wild cards: one per color slot (all render identically), floor(card/14) < 4
    // so cardType() classifies them as 'Wild'. Four total, matching a real Lumo deck.
    for (let color = 0; color < 4; color++) {
      deck.push(color * 14 + 13);
    }

    // Wild Draw Four: floor(card/14) >= 4 so cardType() classifies them as 'Draw4'.
    // Four total, matching a real Lumo deck.
    for (let color = 0; color < 4; color++) {
      deck.push((4 + color) * 14 + 13);
    }

    // Give Plus One: two per color, matching the Skip/Reverse/Draw Two count. Brings
    // the deck to 116 cards, matching public/lumo-rules.md.
    for (let color = 0; color < 4; color++) {
      deck.push(GIVE_PLUS_ONE_BASE + color);
      deck.push(GIVE_PLUS_ONE_BASE + color);
    }

    return deck;
  }

  function cardColor(card) {
    if (isGivePlusOneCard(card)) {
      return COLOR_NAMES[card - GIVE_PLUS_ONE_BASE];
    }

    if (card % 14 === 13) {
      return 'black';
    }

    switch (Math.floor(card / 14)) {
      case 0:
      case 4:
        return 'red';
      case 1:
      case 5:
        return 'yellow';
      case 2:
      case 6:
        return 'green';
      case 3:
      case 7:
        return 'blue';
      default:
        return 'unknown';
    }
  }

  function getCurrentBoardColor(table) {
    if (!table || !table.game) {
      return null;
    }

    if (table.game.chosenColor) {
      return table.game.chosenColor;
    }

    return cardColor(table.game.cardOnBoard);
  }

  function canPlayCardOnBoard(table, card) {
    if (!table || !table.game || typeof card !== 'number') {
      return false;
    }

    const currentCard = table.game.cardOnBoard;
    const currentColor = getCurrentBoardColor(table);
    const cardColorName = cardColor(card);
    const currentCardType = cardType(currentCard);

    if (cardColorName === 'black') {
      return true;
    }

    if (cardColorName === currentColor) {
      return true;
    }

    return cardType(card) === currentCardType;
  }

  function hasPlayableCard(table, hand) {
    if (!Array.isArray(hand)) {
      return false;
    }

    return hand.some(function (card) {
      return canPlayCardOnBoard(table, card);
    });
  }

  function cardType(card) {
    if (isGivePlusOneCard(card)) {
      return 'GivePlusOne';
    }

    switch (card % 14) {
      case 10:
        return 'Skip';
      case 11:
        return 'Reverse';
      case 12:
        return 'Draw2';
      case 13:
        return Math.floor(card / 14) >= 4 ? 'Draw4' : 'Wild';
      default:
        return 'Number ' + (card % 14);
    }
  }

  function capitalizeWord(word) {
    if (typeof word !== 'string' || !word) {
      return '';
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function formatCardTypeForNarration(type) {
    if (type.indexOf('Number ') === 0) {
      return type.replace('Number ', '');
    }

    if (type === 'Draw2') {
      return 'Draw Two';
    }

    if (type === 'Draw4') {
      return 'Draw Four';
    }

    if (type === 'GivePlusOne') {
      return 'Give Plus One';
    }

    return type;
  }

  function describeCard(card, chosenColor) {
    if (typeof card !== 'number') {
      return 'No card';
    }

    const resolvedColor = cardColor(card) === 'black' ? chosenColor : cardColor(card);
    const formattedType = formatCardTypeForNarration(cardType(card));

    if (cardColor(card) === 'black') {
      return resolvedColor ? (formattedType + ' ' + resolvedColor) : formattedType;
    }

    return formattedType + ' ' + resolvedColor;
  }

  function describeCardForAnnouncement(card, chosenColor) {
    if (typeof card !== 'number') {
      return 'No card';
    }

    return describeCard(card, chosenColor);
  }

  function getTurnDirectionLabel(reverseFlag) {
    return reverseFlag ? 'counterclockwise' : 'clockwise';
  }

  function createInactiveStackState() {
    return {
      active: false,
      type: null,
      penalty: 0,
      activeColor: null,
      starterId: null,
      starterName: '',
      roundEndPending: false,
      lastPlayerId: null,
      lastPlayerName: '',
      respondingPlayerId: null,
      respondingPlayerName: ''
    };
  }

  function getStackTypeLabel(stackType) {
    return stackType === 'Draw4' ? 'Wild Draw Four' : 'Draw Two';
  }

  function getStackPenaltyAmount(stackType) {
    return stackType === 'Draw4' ? 4 : 2;
  }

  function isLegalWildDrawFourPlay(table, hand, card) {
    if (cardType(card) !== 'Draw4' || !Array.isArray(hand)) {
      return false;
    }

    const boardColor = getCurrentBoardColor(table);
    return !hand.some(function (handCard) {
      return handCard !== card && cardColor(handCard) !== 'black' && cardColor(handCard) === boardColor;
    });
  }

  function hasLegalStackCard(table, hand, stackType) {
    if (!Array.isArray(hand)) {
      return false;
    }

    if (stackType === 'Draw2') {
      return hand.some(function (card) {
        return cardType(card) === 'Draw2';
      });
    }

    if (stackType === 'Draw4') {
      return hand.some(function (card) {
        return cardType(card) === 'Draw4';
      });
    }

    return false;
  }

  function buildStackStatePayload(table, viewerId) {
    if (!table || !table.game || !table.game.stack) {
      return createInactiveStackState();
    }

    const stack = table.game.stack;
    const currentPlayer = table.players[table.game.turn] || null;
    const viewerIsCurrentPlayer = !!(currentPlayer && currentPlayer.id === viewerId);
    const canContinue = !!(stack.active && viewerIsCurrentPlayer && hasLegalStackCard(table, currentPlayer.hand, stack.type));

    return {
      active: !!stack.active,
      type: stack.type,
      penalty: stack.penalty || 0,
      activeColor: stack.activeColor || null,
      lastPlayerId: stack.lastPlayerId || null,
      lastPlayerName: stack.lastPlayerName || '',
      respondingPlayerId: currentPlayer ? currentPlayer.id : null,
      respondingPlayerName: currentPlayer ? currentPlayer.name : '',
      canContinue: canContinue,
      canAcceptPenalty: !!viewerIsCurrentPlayer,
      promptText: canContinue
        ? ('You may play a ' + getStackTypeLabel(stack.type) + ' or draw ' + (stack.penalty || 0) + ' cards.')
        : ('You must draw ' + (stack.penalty || 0) + ' cards.')
    };
  }

  function createInactiveGiveState() {
    return {
      active: false,
      isGiver: false,
      isReceiver: false,
      fromPlayerName: '',
      toPlayerName: ''
    };
  }

  function buildGivePendingStatePayload(table, viewerId) {
    if (!table || !table.game || !table.game.pendingGive) {
      return createInactiveGiveState();
    }

    const pending = table.game.pendingGive;
    return {
      active: true,
      isGiver: viewerId === pending.fromPlayerId,
      isReceiver: viewerId === pending.toPlayerId,
      fromPlayerName: pending.fromPlayerName,
      toPlayerName: pending.toPlayerName
    };
  }

  function clearActiveStack(table) {
    if (!table || !table.game) {
      return;
    }

    table.game.stack = createInactiveStackState();
  }

  function activateStack(table, currentPlayer, card, chosenColor) {
    if (!table || !table.game || !currentPlayer) {
      return;
    }

    const stackType = cardType(card);
    const nextPlayerIndex = getNextPlayerIndex(table, getPlayerIndex(table, currentPlayer.id), 1);
    const nextPlayer = table.players[nextPlayerIndex] || null;

    table.game.stack = {
      active: true,
      type: stackType,
      penalty: getStackPenaltyAmount(stackType),
      activeColor: stackType === 'Draw4' ? chosenColor : getCurrentBoardColor(table),
      starterId: currentPlayer.id,
      starterName: currentPlayer.name,
      roundEndPending: currentPlayer.hand.length === 0,
      lastPlayerId: currentPlayer.id,
      lastPlayerName: currentPlayer.name,
      respondingPlayerId: nextPlayer ? nextPlayer.id : null,
      respondingPlayerName: nextPlayer ? nextPlayer.name : ''
    };
  }

  function resolveStackPenalty(table) {
    if (!table || !table.game || !table.game.stack || !table.game.stack.active) {
      return false;
    }

    const playerIndex = table.game.turn;
    const player = table.players[playerIndex];
    if (!player) {
      clearActiveStack(table);
      return false;
    }

    const stack = table.game.stack;
    const stackLabel = getStackTypeLabel(stack.type);
    const activeColorText = stack.type === 'Draw4' && stack.activeColor ? (' ' + capitalizeWord(stack.activeColor) + ' remains the active color.') : '';
    const nextIndex = getNextPlayerIndex(table, playerIndex, 1);
    const nextPlayer = table.players[nextIndex] || null;
    const starterIndex = getPlayerIndex(table, stack.starterId);
    const starterPlayer = starterIndex >= 0 ? table.players[starterIndex] : null;
    const roundEndPending = !!stack.roundEndPending;

    drawCardsFromDeck(table, playerIndex, stack.penalty);
    io.to(player.id).emit('haveCard', player.hand);

    const transitionMessage = player.name + ' draws ' + stack.penalty + ' cards and loses their turn.' + activeColorText;

    if (roundEndPending && player.id !== stack.starterId && starterIndex >= 0) {
      clearActiveStack(table);
      io.to(table.id).emit('turnTransition', {
        action: 'stack_resolve',
        actorId: player.id,
        actorName: player.name,
        stackType: stack.type,
        stackPenalty: stack.penalty,
        stackLabel: stackLabel,
        stackActiveColor: stack.activeColor || null,
        nextPlayerId: starterPlayer ? starterPlayer.id : null,
        nextPlayerName: starterPlayer ? starterPlayer.name : '',
        message: transitionMessage + (starterPlayer ? ' ' + starterPlayer.name + ' wins the round.' : '')
      });

      endRound(table, starterIndex, 'stack_resolved');
      return true;
    }

    clearActiveStack(table);
    advanceTurn(table, 1);
    emitTableState(table);

    io.to(table.id).emit('turnTransition', {
      action: 'stack_resolve',
      actorId: player.id,
      actorName: player.name,
      stackType: stack.type,
      stackPenalty: stack.penalty,
      stackLabel: stackLabel,
      stackActiveColor: stack.activeColor || null,
      nextPlayerId: nextPlayer ? nextPlayer.id : null,
      nextPlayerName: nextPlayer ? nextPlayer.name : '',
      message: transitionMessage + (nextPlayer ? ' It is ' + nextPlayer.name + "'s turn." : '')
    });

    emitTurnPlayer(table);
    return true;
  }

  function cardScore(card) {
    if (typeof card !== 'number') {
      return 0;
    }

    if (isGivePlusOneCard(card)) {
      return 20;
    }

    if (cardColor(card) === 'black') {
      return 50;
    }

    const value = card % 14;
    if (value >= 10) {
      return 20;
    }

    return value;
  }

  function getHighestStarterDrawIndex(draws) {
    let highestIndex = 0;
    let highestCard = draws[0] ? draws[0].card : -1;
    draws.forEach(function (draw, index) {
      if (draw.card > highestCard) {
        highestCard = draw.card;
        highestIndex = index;
      }
    });
    return highestIndex;
  }

  // --- Computer player (bot) decision logic ---
  // Bots act through the same performDrawCard/performPlayCard/performAcceptStackPenalty/
  // performSubmitGiveCard functions real sockets use (see registerSocketHandlers), so
  // the rules a bot can and cannot do are identical to a human player - only card/color
  // selection below is bot-specific.

  function isBotActionCard(card) {
    const type = cardType(card);
    return type === 'Skip' || type === 'Reverse' || type === 'Draw2' || type === 'GivePlusOne';
  }

  function pickHighestScoreCard(cards) {
    return cards.reduce(function (best, candidate) {
      return cardScore(candidate) > cardScore(best) ? candidate : best;
    }, cards[0]);
  }

  function randomColorChoice() {
    return COLOR_NAMES[Math.floor(Math.random() * COLOR_NAMES.length)];
  }

  function pickBestColorForBot(hand, excludeCard) {
    const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    hand.forEach(function (card) {
      if (card === excludeCard) {
        return;
      }
      const color = cardColor(card);
      if (counts[color] !== undefined) {
        counts[color] += 1;
      }
    });

    let bestColor = COLOR_NAMES[0];
    let bestCount = -1;
    COLOR_NAMES.forEach(function (color) {
      if (counts[color] > bestCount) {
        bestCount = counts[color];
        bestColor = color;
      }
    });
    return bestColor;
  }

  function getLegalBotCards(table, bot) {
    const stack = table.game.stack;
    if (stack && stack.active) {
      return bot.hand.filter(function (card) {
        return cardType(card) === stack.type;
      });
    }

    return bot.hand.filter(function (card) {
      if (!canPlayCardOnBoard(table, card)) {
        return false;
      }
      if (cardType(card) === 'Draw4') {
        return isLegalWildDrawFourPlay(table, bot.hand, card);
      }
      return true;
    });
  }

  // Skill 1 (easy): random legal card, random wild color.
  // Skill 2 (medium): always sheds its highest point-value legal card.
  // Skill 3 (hard): prefers disruptive action cards over plain numbers, saves
  // Wild/Draw4 for when nothing else is legal, and picks wild colors to match
  // whatever color it is holding the most of.
  function chooseBotPlay(table, bot) {
    const legalCards = getLegalBotCards(table, bot);
    if (legalCards.length === 0) {
      return null;
    }

    const skill = bot.botSkill || 2;
    let card;

    if (skill <= 1) {
      card = legalCards[Math.floor(Math.random() * legalCards.length)];
    } else if (skill === 2) {
      card = pickHighestScoreCard(legalCards);
    } else {
      const actionCards = legalCards.filter(isBotActionCard);
      const numberCards = legalCards.filter(function (c) {
        return cardColor(c) !== 'black' && !isBotActionCard(c);
      });
      const draw4Cards = legalCards.filter(function (c) {
        return cardType(c) === 'Draw4';
      });

      if (actionCards.length) {
        card = pickHighestScoreCard(actionCards);
      } else if (numberCards.length) {
        card = pickHighestScoreCard(numberCards);
      } else if (draw4Cards.length) {
        card = draw4Cards[0];
      } else {
        card = legalCards[0];
      }
    }

    const isWild = cardColor(card) === 'black';
    const chosenColor = isWild ? (skill <= 1 ? randomColorChoice() : pickBestColorForBot(bot.hand, card)) : null;
    return { card: card, chosenColor: chosenColor };
  }

  function chooseBotGiveCard(table, bot) {
    if (!bot.hand.length) {
      return null;
    }
    if ((bot.botSkill || 2) <= 1) {
      return bot.hand[Math.floor(Math.random() * bot.hand.length)];
    }
    return pickHighestScoreCard(bot.hand);
  }

  function scheduleBotAction(table, botId) {
    if (!table || !table.game) {
      return;
    }
    if (table.game.botTimer) {
      clearTimeout(table.game.botTimer);
    }
    table.game.botTimer = setTimeout(function () {
      table.game.botTimer = null;
      runBotTurn(table.id, botId);
    }, BOT_MOVE_DELAY_MS);
  }

  // Central hook: called at the end of emitTurnPlayer() (the same signal a human
  // client uses to know it must act) so a bot's move is scheduled exactly when a
  // human would be prompted to draw/play - see also the direct scheduleBotAction()
  // call from performPlayCard()'s Give Plus One branch, which pauses the turn
  // without calling emitTurnPlayer().
  function maybeScheduleBotTurn(table) {
    if (!table || !table.game || table.status !== 'in_game' || table.game.locked || table.game.pendingGive) {
      return;
    }

    const currentPlayer = table.players[table.game.turn];
    if (currentPlayer && currentPlayer.isBot) {
      scheduleBotAction(table, currentPlayer.id);
    }
  }

  function runBotTurn(tableId, botId) {
    const table = tables[tableId];
    if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
      return;
    }

    const pending = table.game.pendingGive;
    if (pending) {
      if (pending.fromPlayerId !== botId) {
        return;
      }
      const bot = table.players[getPlayerIndex(table, botId)];
      if (!bot || !bot.isBot) {
        return;
      }
      const card = chooseBotGiveCard(table, bot);
      if (typeof card !== 'number') {
        return;
      }
      performSubmitGiveCard(table, botId, { card: card });
      return;
    }

    const currentPlayer = table.players[table.game.turn];
    if (!currentPlayer || currentPlayer.id !== botId || !currentPlayer.isBot) {
      return;
    }

    const stack = table.game.stack;
    if (stack && stack.active) {
      const play = chooseBotPlay(table, currentPlayer);
      if (play) {
        performPlayCard(table, botId, play);
      } else {
        performAcceptStackPenalty(table, botId);
      }
      return;
    }

    if (hasPlayableCard(table, currentPlayer.hand)) {
      const play = chooseBotPlay(table, currentPlayer);
      if (play) {
        performPlayCard(table, botId, play);
        return;
      }
    }

    performDrawCard(table, botId);
  }

  function initializeGameState(table) {
    table.game = {
      deck: createDeck(),
      reverse: 0,
      turn: 0,
      cardOnBoard: 0,
      chosenColor: null,
      hasDrawn: false,
      locked: false,
      roundNumber: 1,
      startingPlayerIndex: 0,
      lastRoundPoints: {},
      stack: createInactiveStackState(),
      pendingGive: null
    };

    shuffle(table.game.deck);
  }

  function drawStarterCards(table) {
    const draws = table.players.map(function (player) {
      ensureDeckNotEmpty(table);
      const card = parseInt(table.game.deck.shift(), 10);
      return {
        id: player.id,
        name: player.name,
        card: card,
        score: cardScore(card),
        description: describeCard(card)
      };
    });

    const highestIndex = getHighestStarterDrawIndex(draws);
    const winner = draws[highestIndex];

    draws.forEach(function (draw) {
      table.game.deck.push(draw.card);
    });
    shuffle(table.game.deck);

    table.game.startingPlayerIndex = highestIndex;

    io.to(table.id).emit('starterDrawSummary', {
      draws: draws,
      winner: winner,
      winnerIndex: highestIndex,
      message: winner.name + ' starts the first round with ' + winner.description + ' worth ' + winner.score + ' points.'
    });
    io.to(table.id).emit('actionNotice', 'Each player drew one card to determine the first starter. ' + winner.name + ' goes first.');
  }

  function beginRound(table, options) {
    const isFirstRound = !!(options && options.isFirstRound);

    if (!isFirstRound) {
      table.game.deck = createDeck();
      shuffle(table.game.deck);
    }

    table.game.reverse = 0;
    table.game.cardOnBoard = 0;
    table.game.chosenColor = null;
    table.game.hasDrawn = false;
    table.game.locked = false;
    table.game.lastRoundPoints = {};
    table.game.stack = createInactiveStackState();
    table.game.pendingGive = null;

    table.players.forEach(function (player) {
      player.hand = [];
    });

    const dealStartIndex = normalizeIndexShared(table.game.startingPlayerIndex + 1, table.players.length);

    for (let i = 0; i < table.players.length * 7; i++) {
      const playerIndex = normalizeIndexShared(i + dealStartIndex, table.players.length);
      ensureDeckNotEmpty(table);
      const card = parseInt(table.game.deck.shift(), 10);
      table.players[playerIndex].hand.push(card);
    }

    let starterCard;
    do {
      ensureDeckNotEmpty(table);
      starterCard = parseInt(table.game.deck.shift(), 10);
      if (cardColor(starterCard) === 'black') {
        table.game.deck.push(starterCard);
        shuffle(table.game.deck);
      } else {
        break;
      }
    } while (true);

    table.game.cardOnBoard = starterCard;
    table.game.turn = table.game.startingPlayerIndex;

    if (cardType(starterCard) === 'Draw2') {
      drawCardsFromDeck(table, table.game.turn, 2);
      advanceTurn(table, 1);
    } else if (cardType(starterCard) === 'Reverse') {
      table.game.reverse = 1;
      if (table.players.length === 2) {
        advanceTurn(table, 1);
      }
    } else if (cardType(starterCard) === 'Skip') {
      advanceTurn(table, 1);
    }

    sendHands(table);
    emitDiscardCard(table);
    emitTurnPlayer(table);
    emitTableState(table);
    emitLobbySnapshotAll();

    if (isFirstRound && options && options.announceStarter) {
      const starterName = table.players[table.game.startingPlayerIndex] ? table.players[table.game.startingPlayerIndex].name : '';
      io.to(table.id).emit('actionNotice', starterName + ' starts the first round.');
    }
  }

  function startGame(table) {
    const settings = getMatchSettings(table);
    const botSlots = Math.max(0, Math.min(settings.computerPlayers, MAX_PLAYERS - table.players.length));

    if (table.players.length + botSlots < MIN_PLAYERS) {
      return { success: false, message: 'At least 2 players are required to start a game' };
    }

    addComputerPlayersToTable(table, botSlots, settings.computerSkill);

    table.status = 'in_game';
    initializeGameState(table);
    drawStarterCards(table);
    beginRound(table, {
      isFirstRound: true,
      announceStarter: true
    });
    return { success: true };
  }

  function ensureDeckNotEmpty(table) {
    if (table.game.deck.length === 0) {
      const freshDeck = createDeck();
      shuffle(freshDeck);
      table.game.deck = freshDeck;
    }
  }

  function drawCardsFromDeck(table, playerIndex, count) {
    for (let i = 0; i < count; i++) {
      ensureDeckNotEmpty(table);
      const card = parseInt(table.game.deck.shift(), 10);
      table.players[playerIndex].hand.push(card);
    }
  }

  function sendHands(table) {
    table.players.forEach(function (player) {
      io.to(player.id).emit('haveCard', player.hand);
    });
  }

  function emitDiscardCard(table) {
    io.to(table.id).emit('sendCard', {
      card: table.game.cardOnBoard,
      chosenColor: table.game.chosenColor
    });
  }

  function emitTurnPlayer(table) {
    const currentPlayer = table.players[table.game.turn];
    if (!currentPlayer) {
      return;
    }

    // A player with no legal stack continuation must explicitly draw (acceptStackPenalty)
    // rather than being auto-resolved here - inspecting their hand to decide for them
    // would leak whether they hold a Draw Two / Wild Draw Four to anyone watching the
    // resulting transition. Each recipient also gets their own stackState so only the
    // affected player learns whether they can continue.
    const canPlay = hasPlayableCard(table, currentPlayer.hand);
    const topDiscard = describeCard(table.game.cardOnBoard, table.game.chosenColor);

    table.players.forEach(function (player) {
      io.to(player.id).emit('turnPlayer', {
        id: currentPlayer.id,
        name: currentPlayer.name,
        canPlay: canPlay,
        mustDraw: !canPlay,
        topDiscard: topDiscard,
        stackState: buildStackStatePayload(table, player.id)
      });
    });

    maybeScheduleBotTurn(table);
  }

  function emitTurnTransition(table, transition) {
    if (!table || !table.players || !transition) {
      return;
    }

    table.players.forEach(function (player) {
      const payload = {
        action: transition.action || 'play',
        actorId: transition.actorId || null,
        actorName: transition.actorName || '',
        playedCard: transition.playedCard || '',
        playedType: transition.playedType || '',
        actorHasUno: !!transition.actorHasUno,
        colorChangedTo: transition.colorChangedTo || null,
        skippedPlayerId: transition.skippedPlayerId || null,
        skippedPlayerName: transition.skippedPlayerName || '',
        direction: transition.direction || null,
        nextPlayerId: transition.nextPlayerId || null,
        nextPlayerName: transition.nextPlayerName || '',
        message: transition.message || '',
        stackActive: !!transition.stackActive,
        stackType: transition.stackType || null,
        stackPenalty: transition.stackPenalty || 0,
        stackActiveColor: transition.stackActiveColor || null,
        stackMessage: transition.stackMessage || ''
      };

      if (transition.draw) {
        payload.draw = {
          playerId: transition.draw.playerId || null,
          playerName: transition.draw.playerName || '',
          count: transition.draw.count || 0,
          cards: player.id === transition.draw.playerId && Array.isArray(transition.draw.cards)
            ? transition.draw.cards.slice()
            : []
        };
      }

      io.to(player.id).emit('turnTransition', payload);
    });
  }

  function advanceTurn(table, steps) {
    table.game.turn = getNextPlayerIndex(table, table.game.turn, steps);
    table.game.hasDrawn = false;
  }

  function calculateRoundPoints(table, winnerIndex) {
    let points = 0;
    for (let i = 0; i < table.players.length; i++) {
      if (i === winnerIndex) {
        continue;
      }

      table.players[i].hand.forEach(function (card) {
        points += cardScore(card);
      });
    }
    return points;
  }

  function buildScoreboard(table) {
    return table.players.map(function (player) {
      const totalPoints = typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0;
      const roundPoints = table.game && table.game.lastRoundPoints && typeof table.game.lastRoundPoints[player.name] === 'number'
        ? table.game.lastRoundPoints[player.name]
        : 0;

      return {
        name: player.name,
        roundPoints: roundPoints,
        totalPoints: totalPoints
      };
    }).sort(function (a, b) {
      return b.totalPoints - a.totalPoints;
    });
  }

  function getPlayerScore(table, playerName) {
    return typeof table.scores[playerName] === 'number' ? table.scores[playerName] : 0;
  }

  function getRoundPoints(table, playerName) {
    if (!table.game || !table.game.lastRoundPoints) {
      return 0;
    }

    return typeof table.game.lastRoundPoints[playerName] === 'number' ? table.game.lastRoundPoints[playerName] : 0;
  }

  function tryBeginNextRound(table) {
    if (!table.game || !table.game.pendingRoundAcks) {
      return;
    }

    if (Object.keys(table.game.pendingRoundAcks).length > 0 || table.status !== 'in_game') {
      return;
    }

    table.game.pendingRoundAcks = null;
    beginRound(table, {
      isFirstRound: false,
      announceStarter: false
    });
  }

  function endRound(table, winnerIndex, reason) {
    if (!table.players[winnerIndex]) {
      return;
    }

    clearActiveStack(table);

    const matchSettings = table.matchSettings || { winningScore: MATCH_POINTS_TO_WIN, maxRounds: DEFAULT_MAX_ROUNDS };
    const winnerName = table.players[winnerIndex].name;
    const roundPoints = calculateRoundPoints(table, winnerIndex);
    table.scores[winnerName] = (table.scores[winnerName] || 0) + roundPoints;

    table.game.lastRoundPoints = {};
    table.players.forEach(function (player) {
      table.game.lastRoundPoints[player.name] = player.hand.reduce(function (sum, card) {
        return sum + cardScore(card);
      }, 0);
    });

    const roundNumber = table.game.roundNumber || 1;
    const scoreboard = buildScoreboard(table);
    const scoreWinner = scoreboard.find(function (entry) {
      return entry.totalPoints >= matchSettings.winningScore;
    }) || null;
    const roundsExhausted = roundNumber >= matchSettings.maxRounds;
    const matchWinner = scoreWinner || (roundsExhausted ? scoreboard[0] : null);
    const matchEndReason = scoreWinner ? 'winning_score' : (roundsExhausted ? 'max_rounds' : null);

    io.to(table.id).emit('roundSummary', {
      winner: winnerName,
      roundPoints: roundPoints,
      scores: scoreboard,
      reason: reason || 'round_end',
      matchWinner: matchWinner,
      roundNumber: roundNumber,
      maxRounds: matchSettings.maxRounds
    });

    table.players.forEach(function (player) {
      player.hand = [];
    });

    emitTableState(table);
    emitLobbySnapshotAll();

    if (matchWinner) {
      io.to(table.id).emit('matchSummary', {
        winner: matchWinner.name,
        score: matchWinner.totalPoints,
        scores: scoreboard,
        reason: matchEndReason,
        roundNumber: roundNumber
      });

      table.players.forEach(function (player) {
        recordGameResult(player.accountId, 'uno', player.name === matchWinner.name ? 'win' : 'loss');
      });

      table.status = 'waiting';
      table.game = null;
      emitTableState(table);
      emitLobbySnapshotAll();
      return;
    }

    table.game.locked = true;
    table.game.roundNumber = roundNumber + 1;
    table.game.startingPlayerIndex = normalizeIndexShared(table.game.startingPlayerIndex + 1, table.players.length);
    table.game.pendingRoundAcks = {};
    table.players.forEach(function (player) {
      // Bots have no client to send ackRoundSummary, so they must not gate the
      // next round - only wait on human players here.
      if (!player.isBot) {
        table.game.pendingRoundAcks[player.id] = true;
      }
    });
    tryBeginNextRound(table);
  }

  function onPlayerRemoved(table, removedIndex, playerName) {
    if (table.status !== 'in_game' || !table.game) {
      return;
    }

    const removedPlayer = table.players[removedIndex];

    if (table.game.pendingGive && removedPlayer
      && (table.game.pendingGive.fromPlayerId === removedPlayer.id || table.game.pendingGive.toPlayerId === removedPlayer.id)) {
      table.game.pendingGive = null;
    }

    if (removedPlayer && removedPlayer.hand.length) {
      removedPlayer.hand.forEach(function (card) {
        table.game.deck.push(card);
      });
      shuffle(table.game.deck);
    }

    if (removedIndex < table.game.turn) {
      table.game.turn -= 1;
    }

    if (removedIndex < table.game.startingPlayerIndex) {
      table.game.startingPlayerIndex -= 1;
    }

    if (removedIndex === table.game.turn && table.game.turn >= table.players.length - 1) {
      table.game.turn = 0;
    }

    if (removedPlayer && table.game.pendingRoundAcks) {
      delete table.game.pendingRoundAcks[removedPlayer.id];
      tryBeginNextRound(table);
    }

    io.to(table.id).emit('actionNotice', playerName + ' left the game');
  }

  // Called by removePlayerFromTable() after splicing the seat out, only when the
  // table is mid-game. Returns true if it already emitted tableState/lobbySnapshot
  // itself (the "round auto-ends" path), false if the generic caller still needs to.
  function onPlayerCountSettled(table) {
    if (table.players.length === 1) {
      endRound(table, 0, 'last_player_remaining');
      return true;
    }

    table.game.turn = normalizeIndexShared(table.game.turn, table.players.length);
    sendHands(table);
    emitDiscardCard(table);
    emitTurnPlayer(table);
    return false;
  }

  function onReconnect(table, player, previousSocketId) {
    if (table.game && table.game.pendingRoundAcks && table.game.pendingRoundAcks[previousSocketId]) {
      table.game.pendingRoundAcks[player.id] = true;
      delete table.game.pendingRoundAcks[previousSocketId];
    }

    if (table.status === 'in_game' && table.game) {
      io.to(player.id).emit('haveCard', player.hand);
      emitDiscardCard(table);
      emitTurnPlayer(table);
    }
  }

  function buildTableStateExtra(table, socketId) {
    return {
      stackState: buildStackStatePayload(table, socketId),
      givePendingState: buildGivePendingStatePayload(table, socketId)
    };
  }

  function getPlayerSummaryFields(table, player) {
    return {
      cardCount: table.status === 'in_game' ? player.hand.length : 0,
      score: getPlayerScore(table, player.name),
      roundPoints: getRoundPoints(table, player.name)
    };
  }

  function applyTestState(table, payload) {
    if (!table.game) {
      initializeGameState(table);
    }

    if (payload.game) {
      if (typeof payload.game.turn === 'number') {
        table.game.turn = payload.game.turn;
      }
      if (typeof payload.game.reverse === 'number') {
        table.game.reverse = payload.game.reverse;
      }
      if (typeof payload.game.cardOnBoard === 'number') {
        table.game.cardOnBoard = payload.game.cardOnBoard;
      }
      if (typeof payload.game.chosenColor === 'string' || payload.game.chosenColor === null) {
        table.game.chosenColor = payload.game.chosenColor;
      }
      if (Array.isArray(payload.game.deck)) {
        table.game.deck = payload.game.deck.slice();
      }
      if (payload.game.stack) {
        table.game.stack = Object.assign(createInactiveStackState(), payload.game.stack);
      }
      if (payload.game.pendingGive) {
        table.game.pendingGive = Object.assign({}, payload.game.pendingGive);
      }
      if (typeof payload.game.locked === 'boolean') {
        table.game.locked = payload.game.locked;
      }
      if (typeof payload.game.hasDrawn === 'boolean') {
        table.game.hasDrawn = payload.game.hasDrawn;
      }
    }

    if (payload.emitDiscardCard) {
      emitDiscardCard(table);
    }

    if (payload.emitTurnPlayer) {
      emitTurnPlayer(table);
    }
  }

  // --- Shared gameplay actions ---
  // Each function below holds the full logic for one gameplay action, addressed by
  // actingId (== the acting player's table.players[].id) rather than a live socket.
  // The registerSocketHandlers() socket.on() handlers are thin wrappers that call
  // these with socket.id; runBotTurn() calls the same functions with a bot's id, so
  // bots are bound by exactly the same rules and validation as a human player.
  // Messages meant for the acting player alone use io.to(actingId).emit(...) -
  // equivalent to socket.emit(...) for a real socket, since every Socket.IO
  // connection auto-joins a room named after its own id, and a harmless no-op when
  // actingId is a bot.

  function performDrawCard(table, actingId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
      io.to(actingId).emit('drawResult', { success: false, message: 'Unable to draw a card right now' });
      return;
    }

    const currentPlayer = table.players[table.game.turn];
    if (!currentPlayer || currentPlayer.id !== actingId) {
      io.to(actingId).emit('drawResult', { success: false, message: 'It is not your turn' });
      return;
    }

    if (table.game.pendingGive) {
      io.to(actingId).emit('drawResult', { success: false, message: 'Choose a card to give before doing anything else' });
      return;
    }

    if (table.game.hasDrawn) {
      io.to(actingId).emit('drawResult', { success: false, message: 'You already drew this turn' });
      return;
    }

    if (hasPlayableCard(table, currentPlayer.hand)) {
      io.to(actingId).emit('drawResult', {
        success: false,
        message: 'You already have a playable card. Play it instead of drawing.'
      });
      return;
    }

    ensureDeckNotEmpty(table);
    const card = parseInt(table.game.deck.shift(), 10);
    currentPlayer.hand.push(card);
    io.to(currentPlayer.id).emit('haveCard', currentPlayer.hand);

    if (canPlayCardOnBoard(table, card)) {
      emitToTableExcept(table, actingId, 'playerDrewCard', { playerName: currentPlayer.name });
      table.game.hasDrawn = true;
      io.to(actingId).emit('drawResult', {
        success: true,
        card: card,
        message: 'You drew ' + describeCard(card) + '. It is playable. You may play it now.'
      });
      emitTableState(table);
      emitTurnPlayer(table);
      return;
    }

    io.to(actingId).emit('drawResult', {
      success: true,
      card: card,
      message: 'You drew ' + describeCard(card) + '. It is not playable. Turn passes.'
    });

    const nextIndex = getNextPlayerIndex(table, table.game.turn, 1);
    const nextPlayer = table.players[nextIndex];
    const transition = {
      action: 'draw_pass',
      actorId: currentPlayer.id,
      actorName: currentPlayer.name,
      draw: {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        count: 1,
        cards: [describeCardForAnnouncement(card)]
      },
      nextPlayerId: nextPlayer ? nextPlayer.id : null,
      nextPlayerName: nextPlayer ? nextPlayer.name : ''
    };

    advanceTurn(table, 1);
    emitTableState(table);
    emitTurnTransition(table, transition);
    emitTurnPlayer(table);
  }

  // Bots have no real socket connection, so io.to(botId) below is always a no-op -
  // this just mirrors socket.to(table.id).emit(...) (broadcast to the table except
  // the actor) for code paths shared between real sockets and performX() bot calls.
  function emitToTableExcept(table, exceptId, event, payload) {
    table.players.forEach(function (player) {
      if (player.id !== exceptId) {
        io.to(player.id).emit(event, payload);
      }
    });
  }

  function performAcceptStackPenalty(table, actingId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
      io.to(actingId).emit('playResult', { success: false, message: 'Unable to accept the penalty right now' });
      return;
    }

    const currentPlayer = table.players[table.game.turn];
    if (!currentPlayer || currentPlayer.id !== actingId) {
      io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn' });
      return;
    }

    if (!table.game.stack || !table.game.stack.active) {
      io.to(actingId).emit('playResult', { success: false, message: 'There is no active draw stack' });
      return;
    }

    if (table.game.pendingGive) {
      io.to(actingId).emit('playResult', { success: false, message: 'Choose a card to give before doing anything else' });
      return;
    }

    resolveStackPenalty(table);
  }

  function performPlayCard(table, actingId, payload) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.locked) {
      io.to(actingId).emit('playResult', { success: false, message: 'Unable to play a card right now' });
      return;
    }

    const currentPlayerIndex = table.game.turn;
    const currentPlayer = table.players[currentPlayerIndex];
    if (!currentPlayer || currentPlayer.id !== actingId) {
      io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn' });
      return;
    }

    if (table.game.pendingGive) {
      io.to(actingId).emit('playResult', { success: false, message: 'Choose a card to give before doing anything else' });
      return;
    }

    const card = payload ? parseInt(payload.card, 10) : NaN;
    const chosenColor = payload && typeof payload.chosenColor === 'string' ? payload.chosenColor.toLowerCase() : null;

    if (Number.isNaN(card) || currentPlayer.hand.indexOf(card) === -1) {
      io.to(actingId).emit('playResult', { success: false, message: 'That card is not in your hand' });
      return;
    }

    const isWild = cardColor(card) === 'black';
    if (isWild && ['red', 'yellow', 'green', 'blue'].indexOf(chosenColor) === -1) {
      io.to(actingId).emit('playResult', { success: false, message: 'Choose a valid color for your Wild card' });
      return;
    }

    const type = cardType(card);
    const drawTwoStackingEnabled = !!table.matchSettings.allowDrawTwoStacking;
    const drawFourStackingEnabled = !!table.matchSettings.allowWildDrawFourStacking;
    const activeStack = table.game.stack && table.game.stack.active ? table.game.stack : null;
    const canContinueStack = !!(activeStack
      && ((activeStack.type === 'Draw2' && drawTwoStackingEnabled && type === 'Draw2')
        || (activeStack.type === 'Draw4' && drawFourStackingEnabled && type === 'Draw4')));
    const stackWillBeActive = !!(activeStack ? canContinueStack : ((type === 'Draw2' && drawTwoStackingEnabled) || (type === 'Draw4' && drawFourStackingEnabled)));

    if (activeStack) {
      if (!canContinueStack) {
        io.to(actingId).emit('playResult', {
          success: false,
          message: 'You must play a ' + getStackTypeLabel(activeStack.type) + ' or draw the accumulated penalty.'
        });
        return;
      }
    } else if (!canPlayCardOnBoard(table, card)) {
      io.to(actingId).emit('playResult', {
        success: false,
        message: 'Cannot play ' + describeCard(card) + ' on ' + describeCard(table.game.cardOnBoard, table.game.chosenColor)
      });
      return;
    }

    if (!activeStack && cardType(card) === 'Draw4') {
      const boardColor = getCurrentBoardColor(table);
      const hasColorMatch = currentPlayer.hand.some(function (handCard) {
        return handCard !== card && cardColor(handCard) !== 'black' && cardColor(handCard) === boardColor;
      });

      if (hasColorMatch) {
        io.to(actingId).emit('playResult', {
          success: false,
          message: 'Wild Draw Four can only be played when you have no card matching the current color'
        });
        return;
      }
    }

    table.game.cardOnBoard = card;
    table.game.chosenColor = isWild ? chosenColor : null;
    table.game.hasDrawn = false;

    const cardPos = currentPlayer.hand.indexOf(card);
    currentPlayer.hand.splice(cardPos, 1);

    emitDiscardCard(table);
    io.to(currentPlayer.id).emit('haveCard', currentPlayer.hand);

    const cardDescription = describeCard(card, table.game.chosenColor);
    const nextIndexAfterPlay = getNextPlayerIndex(table, currentPlayerIndex, 1);
    const nextPlayerAfterPlay = table.players[nextIndexAfterPlay] || null;
    const willStartStack = !activeStack && ((type === 'Draw2' && drawTwoStackingEnabled) || (type === 'Draw4' && drawFourStackingEnabled));
    const willContinueStack = !!activeStack && canContinueStack;

    if (currentPlayer.hand.length === 1) {
      io.to(table.id).emit('actionNotice', currentPlayer.name + ' says Lumo');
    }

    if (currentPlayer.hand.length === 0 && !stackWillBeActive) {
      io.to(actingId).emit('playResult', { success: true, card: card, message: 'You play a ' + cardDescription + '.' });
      emitToTableExcept(table, actingId, 'cardPlayed', { description: cardDescription });
      clearActiveStack(table);
      endRound(table, currentPlayerIndex, 'all_cards_played');
      return;
    }

    // A Give Plus One that would leave exactly one card cannot give that last card
    // away (public/lumo-rules.md), so it plays like a normal card below: no transfer,
    // turn just advances. With two or more cards left, pause here for the giver to
    // choose - the turn does not advance until submitGiveCard resolves it.
    if (type === 'GivePlusOne' && currentPlayer.hand.length >= 2 && nextPlayerAfterPlay) {
      const giveColor = cardColor(card);
      table.game.pendingGive = {
        fromPlayerId: currentPlayer.id,
        fromPlayerName: currentPlayer.name,
        toPlayerId: nextPlayerAfterPlay.id,
        toPlayerName: nextPlayerAfterPlay.name,
        color: giveColor
      };

      io.to(actingId).emit('playResult', {
        success: true,
        card: card,
        message: 'You play a ' + giveColor + ' Give Plus One.'
      });
      io.to(actingId).emit('giveCardPrompt', { toPlayerName: nextPlayerAfterPlay.name, color: giveColor });
      emitToTableExcept(table, actingId, 'actionNotice', currentPlayer.name + ' plays a ' + giveColor + ' Give Plus One.');
      emitTableState(table);

      if (currentPlayer.isBot) {
        scheduleBotAction(table, currentPlayer.id);
      }
      return;
    }

    let turnSteps = 1;
    let drawEffect = null;
    let skippedPlayer = null;
    let directionLabel = null;
    let stackMessage = '';

    if (willStartStack || willContinueStack) {
      if (!activeStack) {
        activateStack(table, currentPlayer, card, chosenColor);
      } else {
        table.game.stack.penalty = (table.game.stack.penalty || 0) + getStackPenaltyAmount(type);
        table.game.stack.activeColor = type === 'Draw4' ? chosenColor : getCurrentBoardColor(table);
        table.game.stack.respondingPlayerId = nextPlayerAfterPlay ? nextPlayerAfterPlay.id : null;
        table.game.stack.respondingPlayerName = nextPlayerAfterPlay ? nextPlayerAfterPlay.name : '';
      }

      table.game.stack.roundEndPending = !!(table.game.stack && table.game.stack.roundEndPending);
      turnSteps = 1;

      stackMessage = activeStack
        ? (currentPlayer.name + ' stacks ' + getStackTypeLabel(type) + '. Draw penalty is now ' + table.game.stack.penalty + '.')
        : (currentPlayer.name + ' plays ' + getStackTypeLabel(type) + '. Draw penalty is now ' + table.game.stack.penalty + '.');

      if (type === 'Draw4') {
        stackMessage += ' ' + capitalizeWord(chosenColor) + ' is the active color.';
      }
    } else if (type === 'Draw2' || type === 'Draw4') {
      const drawCount = type === 'Draw2' ? 2 : 4;
      const targetIndex = nextIndexAfterPlay;
      const targetPlayer = table.players[targetIndex];
      drawCardsFromDeck(table, targetIndex, drawCount);
      const drawnCards = targetPlayer.hand.slice(-drawCount);
      io.to(targetPlayer.id).emit('haveCard', targetPlayer.hand);

      turnSteps = 2;
      const cardTypeName = type === 'Draw2' ? 'Draw Two' : 'Wild Draw Four';
      const drawWord = type === 'Draw2' ? 'two' : 'four';
      const drawnDescriptions = drawnCards.map(function (drawnCard) {
        return describeCardForAnnouncement(drawnCard);
      });

      drawEffect = {
        playerId: targetPlayer.id,
        playerName: targetPlayer.name,
        count: drawCount,
        cards: drawnDescriptions
      };

      io.to(actingId).emit('playResult', {
        success: true,
        card: card,
        message: 'You play a ' + cardTypeName + ' and ' + targetPlayer.name + ' draws ' + drawWord + ' cards.'
      });
    } else {
      io.to(actingId).emit('playResult', { success: true, card: card, message: 'You play a ' + cardDescription + '.' });

      if (type === 'Skip') {
        turnSteps = 2;
        const skippedIndex = getNextPlayerIndex(table, currentPlayerIndex, 1);
        skippedPlayer = table.players[skippedIndex] || null;
      } else if (type === 'Reverse') {
        table.game.reverse = (table.game.reverse + 1) % 2;
        directionLabel = getTurnDirectionLabel(table.game.reverse);
        if (table.players.length === 2) {
          turnSteps = 2;
        }
      }
    }

    const nextIndex = getNextPlayerIndex(table, currentPlayerIndex, turnSteps);
    const nextPlayer = table.players[nextIndex];
    const transition = {
      action: 'play',
      actorId: currentPlayer.id,
      actorName: currentPlayer.name,
      playedCard: describeCardForAnnouncement(card, table.game.chosenColor),
      playedType: type,
      colorChangedTo: isWild ? capitalizeWord(chosenColor) : null,
      actorHasUno: currentPlayer.hand.length === 1,
      direction: directionLabel,
      nextPlayerId: nextPlayer ? nextPlayer.id : null,
      nextPlayerName: nextPlayer ? nextPlayer.name : ''
    };

    if (stackMessage) {
      transition.stackActive = true;
      transition.stackType = type;
      transition.stackPenalty = table.game.stack.penalty;
      transition.stackActiveColor = table.game.stack.activeColor;
      transition.stackMessage = stackMessage;
    }

    if (drawEffect) {
      transition.draw = drawEffect;
    }
    if (skippedPlayer) {
      transition.skippedPlayerId = skippedPlayer.id;
      transition.skippedPlayerName = skippedPlayer.name;
    }

    advanceTurn(table, turnSteps);
    emitTableState(table);
    emitTurnTransition(table, transition);
    emitTurnPlayer(table);
  }

  function performSubmitGiveCard(table, actingId, payload) {
    if (!table || table.status !== 'in_game' || !table.game || !table.game.pendingGive) {
      io.to(actingId).emit('playResult', { success: false, message: 'There is no pending card to give right now' });
      return;
    }

    const pending = table.game.pendingGive;
    if (pending.fromPlayerId !== actingId) {
      io.to(actingId).emit('playResult', { success: false, message: 'It is not your turn to choose a card to give' });
      return;
    }

    const giver = table.players[getPlayerIndex(table, pending.fromPlayerId)];
    const receiver = table.players[getPlayerIndex(table, pending.toPlayerId)];
    if (!giver || !receiver) {
      table.game.pendingGive = null;
      io.to(actingId).emit('playResult', { success: false, message: 'Unable to complete the card transfer' });
      return;
    }

    const card = payload ? parseInt(payload.card, 10) : NaN;
    const cardPos = giver.hand.indexOf(card);

    // The card just played is already on the discard pile and out of the giver's
    // hand, so this membership check alone keeps it from being given away too.
    if (Number.isNaN(card) || cardPos === -1) {
      io.to(actingId).emit('playResult', { success: false, message: 'Choose a card from your hand to give' });
      return;
    }

    giver.hand.splice(cardPos, 1);
    receiver.hand.push(card);
    table.game.pendingGive = null;

    io.to(giver.id).emit('haveCard', giver.hand);
    io.to(receiver.id).emit('haveCard', receiver.hand);

    const cardDescription = describeCardForAnnouncement(card);
    advanceTurn(table, 1);
    emitTableState(table);

    table.players.forEach(function (player) {
      let message;
      if (player.id === giver.id) {
        message = 'You pass ' + cardDescription + '. It is ' + receiver.name + "'s turn.";
      } else if (player.id === receiver.id) {
        message = giver.name + ' passes ' + cardDescription + ' to you. It is your turn.';
      } else {
        message = giver.name + ' passes ' + cardDescription + ' to ' + receiver.name + ". It is " + receiver.name + "'s turn.";
      }

      io.to(player.id).emit('turnTransition', {
        action: 'give_resolve',
        actorId: giver.id,
        actorName: giver.name,
        nextPlayerId: receiver.id,
        nextPlayerName: receiver.name,
        message: message
      });
    });

    emitTurnPlayer(table);
  }

  function registerSocketHandlers(socket) {
    socket.on('requestDiscardCard', function () {
      const table = deps.findTableBySocket(socket);
      if (!table || table.status !== 'in_game' || !table.game) {
        socket.emit('discardCardInfo', { success: false, message: 'No discard card yet' });
        return;
      }

      socket.emit('discardCardInfo', {
        success: true,
        message: describeCard(table.game.cardOnBoard, table.game.chosenColor)
      });
    });

    socket.on('ackRoundSummary', function () {
      const table = deps.findTableBySocket(socket);
      if (!table || !table.game || !table.game.pendingRoundAcks) {
        return;
      }

      delete table.game.pendingRoundAcks[socket.id];
      tryBeginNextRound(table);
    });

    socket.on('drawCard', function () {
      performDrawCard(deps.findTableBySocket(socket), socket.id);
    });

    socket.on('acceptStackPenalty', function () {
      performAcceptStackPenalty(deps.findTableBySocket(socket), socket.id);
    });

    socket.on('playCard', function (payload) {
      performPlayCard(deps.findTableBySocket(socket), socket.id, payload);
    });

    socket.on('submitGiveCard', function (payload) {
      performSubmitGiveCard(deps.findTableBySocket(socket), socket.id, payload);
    });
  }

  return {
    type: 'uno',
    name: 'Lumo',
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
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
    registerSocketHandlers: registerSocketHandlers,
    // Exposed only for direct in-process testing of card-model logic (deck
    // composition, scoring, etc.) - re-exported from server.js's module.exports.
    createDeck: createDeck,
    cardColor: cardColor,
    cardType: cardType,
    cardScore: cardScore,
    describeCard: describeCard,
    isGivePlusOneCard: isGivePlusOneCard
  };
};
