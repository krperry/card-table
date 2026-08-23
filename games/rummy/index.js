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
//      { type: 'set'|'run', cards: [...], jokers: {...}, mode } groups - see
//      games/rummy/rules.js's "Joker identity resolution" section for what
//      `cards` (logically ordered, not selection order), `jokers` (each
//      Joker's exact stored representation), and `mode` (a run's fixed
//      Ace-position interpretation) mean and why they're stored rather than
//      re-derived on every read. Lay-offs never ask the client to name a
//      specific group - performLayOffCards() auto-resolves which group a
//      marked card attaches to via rules.canExtendMeld()/
//      findBestJokerAssignment(), the same simplification the client's
//      "press 1-6, then L" keyboard flow relies on (see
//      public/games/rummy/rummy-client.js). A genuinely ambiguous meld
//      attempt (rules.resolveMeld()'s needsChoice) is the one case that
//      round-trips back to the client for a Run/Set answer before anything
//      is committed - see performMeldCards() below.
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

  // Mirrors games/lumo/index.js's computerPlayers setting: a host-chosen
  // maximum number of computer players to add when the game starts, read
  // fresh from matchSettings at startGame() time (see startGame()'s header
  // comment) rather than reserved at table-creation time. The table-creation
  // UI only ever offers 1-5 (see public/index.html's
  // new-table-rummy-computer-players select) and defaults to 1 so a lone host
  // can always start a two-player game - see the Default section of the "Add
  // Configurable Computer Players to Rummy Table Creation" issue. The clamp
  // here still accepts 0 (below what the UI can ever send) purely so tests
  // can opt a table out of the default bot entirely to isolate unrelated
  // mechanics - see tests/rummy-game.test.js/tests/rummy-draw-pile.test.js's
  // `{ rummyComputerPlayers: 0 }` table-creation calls.
  const MIN_COMPUTER_PLAYERS_SETTING = 0;
  const MAX_COMPUTER_PLAYERS = 5;
  const DEFAULT_COMPUTER_PLAYERS = 1;
  const MIN_TABLE_PLAYERS = 2;
  const MAX_TABLE_PLAYERS = 6;

  function normalizeMatchSettings(payload) {
    return {
      targetScore: clampInteger(payload && payload.rummyTargetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE),
      // Both optional table rules default OFF, following the same
      // "!!payload.field" convention games/lumo/index.js uses for
      // allowDrawTwoStacking/allowWildDrawFourStacking - a table only opts in
      // when the host explicitly checks the box (see public/index.html's
      // rummy-table-settings and public/main.js's createTable()).
      allowDrawEntirePile: !!(payload && payload.rummyAllowDrawEntirePile),
      aceHighOrLow: !!(payload && payload.rummyAceHighOrLow),
      computerPlayers: clampInteger(payload && payload.rummyComputerPlayers, MIN_COMPUTER_PLAYERS_SETTING, MAX_COMPUTER_PLAYERS, DEFAULT_COMPUTER_PLAYERS)
    };
  }

  function getMatchSettings(table) {
    const matchSettings = table && table.matchSettings ? table.matchSettings : {};
    return {
      targetScore: clampInteger(matchSettings.targetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE),
      allowDrawEntirePile: !!matchSettings.allowDrawEntirePile,
      aceHighOrLow: !!matchSettings.aceHighOrLow,
      computerPlayers: clampInteger(matchSettings.computerPlayers, MIN_COMPUTER_PLAYERS_SETTING, MAX_COMPUTER_PLAYERS, DEFAULT_COMPUTER_PLAYERS)
    };
  }

  // The subset of match settings games/rummy/rules.js's Ace-High-or-Low-aware
  // functions (isValidRun/canExtendMeld/findJokerSwapTarget/
  // findBestJokerAssignment/resolveMeld/resolveGroupExtension/cardValue/
  // scoreHand) accept as their trailing `options` argument - kept as its own
  // tiny helper so every call site below
  // (and games/rummy/bots.js, which receives the same shape via
  // runBotTurn()'s botContext) builds it identically from one source of
  // truth, table.matchSettings, rather than each guessing at the field name.
  function rulesOptions(table) {
    return { aceHighOrLow: getMatchSettings(table).aceHighOrLow };
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
      botTimer: null,
      pendingTurnEvents: [],
      turnStateFlushScheduled: false
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
    queueRummyTurnEvent(table, null);
  }

  function buildTurnMessage(table, recipientIndex, events) {
    const parts = [];
    (events || []).forEach(function (lastEvent) {
      if (!lastEvent) {
        return;
      }
      if (lastEvent.type === 'draw' && lastEvent.playerIndex !== recipientIndex) {
        // The stock is face-down - naming the card would leak hidden
        // information other players aren't supposed to have. The discard
        // pile is face-up, so that card is fair to announce (everyone could
        // already see it sitting on top of the pile).
        if (lastEvent.source === 'pile') {
          parts.push(lastEvent.playerName + ' draws the discard pile.');
        } else if (lastEvent.source === 'discard') {
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
    });
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

  // A bot's whole turn (draw -> meld/layoff -> discard) runs synchronously in
  // one go inside runBotTurn(), which used to call emitRummyTurnState()
  // directly after every single sub-action. Each call sent its own
  // 'rummyTurnState' message, and on the client, srSpeak() cancels any
  // not-yet-rendered previous announcement when a new one arrives (see
  // public/main.js) - so a bot's draw announcement was routinely stomped by
  // its own very next discard announcement arriving a moment later, and a
  // blind opponent never heard the draw at all. Queuing events here and
  // flushing them once via setImmediate - after the whole synchronous burst
  // of perform*() calls for this turn has finished - combines them into a
  // single message/emit instead, e.g. "Amy draws from the stack. Amy
  // discards Nine of Spades. It is your turn." A human player's actions are
  // always separate socket round-trips (real time apart), so in that case
  // there is normally only ever one event queued per flush and this changes
  // nothing observable beyond the same one-tick defer.
  function queueRummyTurnEvent(table, lastEvent) {
    if (!table || !table.game) {
      return;
    }
    if (!Array.isArray(table.game.pendingTurnEvents)) {
      table.game.pendingTurnEvents = [];
    }
    if (lastEvent) {
      table.game.pendingTurnEvents.push(lastEvent);
    }
    if (table.game.turnStateFlushScheduled) {
      return;
    }
    table.game.turnStateFlushScheduled = true;
    setImmediate(function () {
      flushRummyTurnState(table);
    });
  }

  function flushRummyTurnState(table) {
    if (!table || !table.game) {
      return;
    }
    const events = table.game.pendingTurnEvents || [];
    table.game.pendingTurnEvents = [];
    table.game.turnStateFlushScheduled = false;

    // The queued turn may have gone out (finishHand() ran mid-burst, e.g. a
    // meld emptied the hand) since these events were queued - table.game may
    // now be null (game over) or past 'playing' (hand_complete). Either way
    // finishHand() already told players directly (rummyHandSummary/
    // actionNotice); a stale rummyTurnState here would just misreport turn
    // info for a hand that's already over, so drop it.
    if (!table.game || table.game.phase !== 'playing') {
      return;
    }

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
        message: buildTurnMessage(table, index, events)
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

    const options = rulesOptions(table);
    const matchSettings = getMatchSettings(table);
    const topDiscard = table.game.discardPile.length ? table.game.discardPile[table.game.discardPile.length - 1] : null;
    const source = bots.chooseDrawAction(
      table.game.hands[playerIndex],
      topDiscard,
      table.game.discardPile,
      table.game.melds,
      { allowDrawEntirePile: matchSettings.allowDrawEntirePile, rulesOptions: options }
    );
    if (source === 'pile' && matchSettings.allowDrawEntirePile && table.game.discardPile.length) {
      performDrawEntirePile(table, botId);
    } else if (source === 'discard' && topDiscard) {
      performDrawDiscard(table, botId);
    } else {
      performDrawStock(table, botId);
    }
    if (!stillBotsTurn(table, playerIndex)) {
      return;
    }

    // minOpponentHandSize feeds the bot's "opponent is nearly out" Joker
    // aggressiveness rule (see games/rummy/bots.js's scoreJokerPlay()) -
    // computed fresh each turn straight from the authoritative hand sizes,
    // never cached.
    const opponentHandSizes = table.game.hands
      .filter(function (_, index) { return index !== playerIndex; })
      .map(function (opponentHand) { return opponentHand.length; });
    const botContext = {
      minOpponentHandSize: opponentHandSizes.length ? Math.min.apply(null, opponentHandSizes) : null,
      rulesOptions: options
    };

    const decision = bots.chooseMeldsAndLayoffs(table.game.hands[playerIndex], table.game.melds, playerIndex, botContext);
    for (let i = 0; i < decision.melds.length; i++) {
      if (!stillBotsTurn(table, playerIndex)) {
        return;
      }
      // decision.meldTypes[i] (set alongside decision.melds by
      // bots.chooseMeldsAndLayoffs()) tells performMeldCards() which
      // interpretation this candidate was generated as, so a bot is never
      // left stuck on a rules.resolveMeld() needsChoice response - there's
      // no human to answer that prompt. See performMeldCards()'s header.
      performMeldCards(table, botId, decision.melds[i], decision.meldTypes && decision.meldTypes[i]);
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

    const discardCard = bots.chooseDiscard(table.game.hands[playerIndex], options);
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
    queueRummyTurnEvent(table, { type: 'draw', playerIndex: playerIndex, playerName: player.name, source: 'stock' });
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
    queueRummyTurnEvent(table, { type: 'draw', playerIndex: playerIndex, playerName: player.name, source: 'discard', card: card });
  }

  // Optional table rule (matchSettings.allowDrawEntirePile, off by default -
  // see normalizeMatchSettings()): instead of taking just the top discard,
  // the whole discard pile goes into the drawing player's hand as-is - no
  // auto-melding, just like a normal draw, the pile's cards simply become
  // part of the hand for the player to sort/select/meld/discard afterward.
  // Counts as this turn's draw exactly like performDrawStock()/
  // performDrawDiscard() (turnPhase moves to 'action', no second draw
  // allowed), and shares every one of their same-shaped turn/phase guards.
  function performDrawEntirePile(table, actingId) {
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
    if (!getMatchSettings(table).allowDrawEntirePile) {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'Taking the entire discard pile is not allowed at this table' });
      return;
    }
    if (!table.game.discardPile.length) {
      io.to(actingId).emit('rummyDrawResult', { success: false, message: 'The discard pile is empty' });
      return;
    }

    const takenCards = table.game.discardPile.slice();
    table.game.discardPile = [];
    const hand = table.game.hands[playerIndex];
    takenCards.forEach(function (card) { hand.push(card); });
    table.game.turnPhase = 'action';

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyDrawResult', { success: true, source: 'pile', cards: takenCards, message: '' });
    sendHand(table, player, playerIndex);

    emitTableState(table);
    queueRummyTurnEvent(table, { type: 'draw', playerIndex: playerIndex, playerName: player.name, source: 'pile', count: takenCards.length });
  }

  // meldTypeChoice ('run'|'set'), when supplied, only ever matters when the
  // selection is genuinely ambiguous (rules.resolveMeld() ignores it
  // otherwise) - see that function's header. A human client supplies it on a
  // resubmit after the player answers the inline Run/Set prompt (see
  // public/games/rummy/rummy-client.js's rummyMeldChoice* functions); a bot
  // supplies it straight from games/rummy/bots.js's chooseMeldsAndLayoffs()
  // meldTypes hint, computed once per candidate at decision time, so a bot
  // is never left stuck waiting on a prompt no one will answer.
  function performMeldCards(table, actingId, cards, meldTypeChoice) {
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

    const resolution = rules.resolveMeld(cards, rulesOptions(table), meldTypeChoice);
    if (!resolution.ok) {
      io.to(actingId).emit('rummyMeldResult', { success: false, message: resolution.reason });
      return;
    }
    if (resolution.needsChoice) {
      // Not a rejection - the selection is a legal meld either way, but which
      // way is genuinely ambiguous (e.g. "8S, Joker, Joker" - see
      // rules.resolveMeld()'s header). Ask the player; the same cards get
      // resubmitted with meldTypeChoice once they answer, still validated
      // fresh against the current hand/rules either way.
      io.to(actingId).emit('rummyMeldResult', {
        success: false,
        needsChoice: true,
        options: resolution.options,
        message: 'Choose how to meld these cards: a run or a set.'
      });
      return;
    }

    cards.forEach(function (card) {
      hand.splice(hand.indexOf(card), 1);
    });
    table.game.melds[playerIndex].push({ type: resolution.type, cards: resolution.cards, jokers: resolution.jokers, mode: resolution.mode });

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyMeldResult', { success: true, message: '', cards: cards, meldType: resolution.type });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    emitTableState(table);
    queueRummyTurnEvent(table, { type: 'meld', playerIndex: playerIndex, playerName: player.name, meldType: resolution.type });
  }

  // Commits a layoff that's already been fully resolved against ONE group
  // (via rules.resolveLayoff() - see performLayOffCards() below) - shared by
  // both the "exactly one legal meld" and "player answered the meld choice"
  // paths, since committing looks identical either way.
  function commitLayoffToGroup(table, actingId, playerIndex, targetGroups, groupIndex, cards, result) {
    const hand = table.game.hands[playerIndex];
    cards.forEach(function (card) {
      hand.splice(hand.indexOf(card), 1);
    });
    result.returnedJokers.forEach(function (jokerCard) {
      hand.push(jokerCard);
    });
    targetGroups[groupIndex] = result.group;

    const player = table.players[playerIndex];
    io.to(actingId).emit('rummyLayOffResult', { success: true, message: '', returnedJokers: result.returnedJokers, cards: cards, meldTypes: [result.group.type] });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    emitTableState(table);
    queueRummyTurnEvent(table, { type: 'layoff', playerIndex: playerIndex, playerName: player.name, cards: cards });
  }

  // meldChoiceIndex (an index into targetGroups), when supplied, only ever
  // matters when the player's selection was genuinely ambiguous about WHICH
  // of the target seat's meld groups should receive it - see the "Player
  // Must Be Able to Choose Which Meld Receives a Layoff" issue this exists
  // for. A human client supplies it on a resubmit after answering the inline
  // meld-choice prompt (see public/games/rummy/rummy-client.js's
  // rummyChooseLayoffTarget()); a bot never supplies one (there's no human to
  // ask) and instead always gets the first legal option - see below.
  function performLayOffCards(table, actingId, targetPlayerIndex, cards, meldChoiceIndex) {
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

    const options = rulesOptions(table);

    // First: does the ENTIRE selected batch fit legally onto any ONE of the
    // target seat's meld groups by itself (rules.resolveLayoff())? This is
    // the question rules 9-17 (issue: "Player Must Be Able to Choose Which
    // Meld Receives a Layoff") need answered before anything is committed -
    // zero whole-group matches falls through to the older cross-group
    // batch-splitting algorithm below (unchanged, still needed for a batch
    // that legitimately spans more than one group), but two or more matches
    // means there's a genuine choice to make and the player must be asked,
    // exactly like rules.resolveMeld()'s needsChoice does for Run/Set.
    const wholeGroupMatches = targetGroups
      .map(function (group, groupIndex) { return { groupIndex: groupIndex, result: rules.resolveLayoff(group, cards, options) }; })
      .filter(function (entry) { return entry.result; });

    if (wholeGroupMatches.length === 1) {
      commitLayoffToGroup(table, actingId, playerIndex, targetGroups, wholeGroupMatches[0].groupIndex, cards, wholeGroupMatches[0].result);
      return;
    }

    if (wholeGroupMatches.length > 1) {
      const actor = table.players[playerIndex];
      let chosen = null;
      if (typeof meldChoiceIndex === 'number') {
        chosen = wholeGroupMatches.filter(function (entry) { return entry.groupIndex === meldChoiceIndex; })[0] || null;
      }
      if (!chosen && actor && actor.isBot) {
        // No human to ask - a bot always takes the first legal option, same
        // "no needsChoice prompt for a bot" reasoning as performMeldCards()'s
        // meldTypeChoice handling above.
        chosen = wholeGroupMatches[0];
      }
      if (chosen) {
        commitLayoffToGroup(table, actingId, playerIndex, targetGroups, chosen.groupIndex, cards, chosen.result);
        return;
      }
      io.to(actingId).emit('rummyLayOffResult', {
        success: false,
        needsChoice: true,
        targetPlayerIndex: targetIndex,
        groupIndices: wholeGroupMatches.map(function (entry) { return entry.groupIndex; }),
        message: 'Choose which meld should receive these cards.'
      });
      return;
    }

    // Simulate against a deep copy first so the whole batch either lands or
    // rejects together - never partially apply. A screen-reader user needs a
    // single clear reason for a rejected batch, not a half-applied one.
    //
    // Two passes:
    //  1) Joker swaps - a selected real card that exactly matches what a
    //     Joker already in a group is standing in for takes that Joker's
    //     place (rules.findJokerSwapTarget()). This never grows the group
    //     and is unambiguous (there's exactly one slot a given card can
    //     swap into), so it's resolved per-card first, same as before.
    //  2) Batch growth - whatever's left is matched against groups via
    //     rules.findBestJokerAssignment(), which evaluates the WHOLE
    //     remaining selection against a group at once instead of one card
    //     at a time. That's what fixes the "what does a selected Joker
    //     represent" ambiguity: e.g. against an existing 5S-6S-7S run,
    //     selecting Joker+9S must resolve the Joker as 8S (so 9S can also
    //     attach), not as 4S (the first legal position a card-by-card pass
    //     would have found) - see rules.findBestJokerAssignment()'s header.
    //     Repeatedly picking whichever group can currently absorb the most
    //     of what's left also lets a batch spanning more than one of the
    //     target's groups (e.g. some cards for a run, others for a set)
    //     resolve correctly.
    // Groups keep their existing jokers/mode identity going into the
    // simulation (see rules.resolveGroupExtension()'s header on why that
    // stability matters - rule 13) - a shallow copy of the jokers map is
    // enough since neither pass below ever mutates a card string in place,
    // only ever swaps in an entirely new resolved group. (options was
    // already computed above for the whole-group-match check.)
    const simulatedGroups = targetGroups.map(function (group) {
      return { type: group.type, cards: group.cards.slice(), jokers: group.jokers ? Object.assign({}, group.jokers) : undefined, mode: group.mode };
    });
    const assignments = [];
    let remainingCards = cards.slice();

    for (let i = remainingCards.length - 1; i >= 0; i--) {
      const card = remainingCards[i];
      for (let g = 0; g < simulatedGroups.length; g++) {
        const swapJoker = rules.findJokerSwapTarget(simulatedGroups[g], card, options);
        if (swapJoker) {
          simulatedGroups[g] = rules.applyJokerSwap(simulatedGroups[g], card, swapJoker, options);
          assignments.push({ card: card, groupIndex: g, jokerToReturn: swapJoker });
          remainingCards.splice(i, 1);
          break;
        }
      }
    }

    while (remainingCards.length) {
      let bestGroupIndex = -1;
      let bestAssignment = null;
      for (let g = 0; g < simulatedGroups.length; g++) {
        const assignment = rules.findBestJokerAssignment(simulatedGroups[g], remainingCards, options);
        if (assignment.cards.length && (!bestAssignment || assignment.cards.length > bestAssignment.cards.length)) {
          bestAssignment = assignment;
          bestGroupIndex = g;
        }
      }
      if (!bestAssignment) {
        break;
      }
      // bestAssignment.cards preserves the candidate pool's (i.e. the
      // player's original selection) relative order - see
      // findBestJokerAssignment()'s header - which resolveGroupExtension()
      // needs intact to correctly place any brand-new Joker in this batch
      // (rule 12: selection order resolves placement ambiguity here exactly
      // like it does for a fresh meld).
      const extended = rules.resolveGroupExtension(simulatedGroups[bestGroupIndex], bestAssignment.cards, options);
      if (!extended) {
        break;
      }
      simulatedGroups[bestGroupIndex] = extended;
      bestAssignment.cards.forEach(function (card) {
        assignments.push({ card: card, groupIndex: bestGroupIndex, jokerToReturn: null });
        remainingCards.splice(remainingCards.indexOf(card), 1);
      });
    }

    if (remainingCards.length) {
      io.to(actingId).emit('rummyLayOffResult', { success: false, message: rules.cardName(remainingCards[0]) + ' cannot be laid off onto that player’s melds' });
      return;
    }

    // Every touched group's final, logically-ordered, identity-resolved
    // shape already lives in simulatedGroups (see applyJokerSwap()/
    // resolveGroupExtension() above) - commit those wholesale rather than
    // re-deriving the same mutations against the real targetGroups array.
    const returnedJokers = [];
    const touchedGroupIndexes = [];
    assignments.forEach(function (assignment) {
      hand.splice(hand.indexOf(assignment.card), 1);
      if (assignment.jokerToReturn) {
        hand.push(assignment.jokerToReturn);
        returnedJokers.push(assignment.jokerToReturn);
      }
      if (touchedGroupIndexes.indexOf(assignment.groupIndex) === -1) {
        touchedGroupIndexes.push(assignment.groupIndex);
      }
    });
    touchedGroupIndexes.forEach(function (g) {
      targetGroups[g] = simulatedGroups[g];
    });

    const player = table.players[playerIndex];
    const meldTypes = touchedGroupIndexes.map(function (g) { return simulatedGroups[g].type; });
    io.to(actingId).emit('rummyLayOffResult', { success: true, message: '', returnedJokers: returnedJokers, cards: cards, meldTypes: meldTypes });
    sendHand(table, player, playerIndex);

    if (hand.length === 0) {
      finishHand(table, playerIndex);
      return;
    }

    emitTableState(table);
    queueRummyTurnEvent(table, { type: 'layoff', playerIndex: playerIndex, playerName: player.name, cards: cards });
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
    queueRummyTurnEvent(table, { type: 'discard', playerIndex: playerIndex, playerName: player.name, card: card });
  }

  function finishHand(table, wentOutPlayerIndex) {
    const settings = getMatchSettings(table);
    const result = rules.scoreHand(table.game.hands, wentOutPlayerIndex, rulesOptions(table));

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
    const options = rulesOptions(table);
    io.to(table.id).emit('rummyHandSummary', {
      handNumber: table.game.handNumber,
      wentOutPlayerName: null,
      noWinner: true,
      rows: table.players.map(function (player, index) {
        return {
          name: player.name,
          deadwood: table.game.hands[index].reduce(function (sum, c) { return sum + rules.cardValue(c, options); }, 0),
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
  // Cribbage's "always pad to a fixed PLAYER_COUNT" pattern. Instead it
  // follows games/lumo/index.js's model: the host picks a computer-player
  // COUNT (not reserved seats) at table creation, and startGame() decides how
  // many bots to actually add based on how many humans have joined by the
  // time Start Game is pressed - never more than fit in the 6-player maximum,
  // and never fewer than needed to reach the 2-player minimum (a lone host
  // always gets at least one bot, even though the table-creation control only
  // offers 1-5, in case matchSettings.computerPlayers is ever missing/0 -
  // e.g. a table created before this setting existed). See the "Add
  // Configurable Computer Players to Rummy Table Creation" issue for the
  // exact seat-math this mirrors.
  function startGame(table) {
    const settings = getMatchSettings(table);
    const humanCount = table.players.length;
    const openSeats = Math.max(0, MAX_TABLE_PLAYERS - humanCount);
    let botCount = Math.min(settings.computerPlayers, openSeats);
    if (humanCount + botCount < MIN_TABLE_PLAYERS) {
      botCount = Math.min(openSeats, MIN_TABLE_PLAYERS - humanCount);
    }

    if (botCount > 0) {
      addComputerPlayersToTable(table, botCount, 'random');
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
      queueRummyTurnEvent(table, null);
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
        // jokers/mode are optional on an injected test meld - a test that
        // doesn't care about Joker identity can keep constructing plain
        // { type, cards } groups exactly as before (see
        // rules.resolveExistingGroupIdentity(), which lazily derives them
        // from `cards` the first time such a group is touched by a lay-off);
        // one that DOES want to pin an exact assignment can supply them
        // directly instead.
        table.game.melds = g.melds.map(function (seatGroups) {
          return (seatGroups || []).map(function (group) {
            return {
              type: group.type,
              cards: group.cards.slice(),
              jokers: group.jokers ? Object.assign({}, group.jokers) : undefined,
              mode: typeof group.mode !== 'undefined' ? group.mode : undefined
            };
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
      queueRummyTurnEvent(table, null);
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

    socket.on('rummyDrawDiscardPile', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performDrawEntirePile(table, socket.id);
    });

    socket.on('rummyMeldCards', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performMeldCards(table, socket.id, payload && payload.cards, payload && payload.meldTypeChoice);
    });

    socket.on('rummyLayOffCards', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'rummy') {
        return;
      }
      performLayOffCards(table, socket.id, payload && payload.targetPlayerIndex, payload && payload.cards, payload && payload.meldChoiceIndex);
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
    minPlayers: MIN_TABLE_PLAYERS,
    maxPlayers: MAX_TABLE_PLAYERS,
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
