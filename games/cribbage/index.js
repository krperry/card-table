// Cribbage game module. Wires the pure rules engine (games/cribbage/rules.js)
// and simple bot heuristics (games/cribbage/bots.js) into table.game state and
// the Socket.IO events the client drives. Follows the same factory/deps
// shape as games/hearts/index.js and games/spades/index.js - see
// games/registry.js.
//
// Card play is server-authoritative throughout: every socket handler here
// resolves its own table via deps.findTableBySocket() and re-validates the
// move against the rules engine before touching any state, exactly like
// Hearts'/Spades' performPlayCard(). Event names (cribbagePlayCard,
// cribbagePegState, etc.) are all unique to this module so they can never be
// delivered to or acted on by a Hearts/Spades/Lumo table.
//
// The one structural difference from Hearts/Spades: Cribbage can end the game
// mid-hand (a hand's scoring events - his heels, pegging points, show points -
// each individually push a score toward the target, not just a hand-boundary
// total). Every scoring site funnels through awardPoints(), which checks for
// game-over immediately after each award and bails the caller out before any
// further phase advancement if the game just ended - see awardPoints() and
// maybeEndGameMidHand() below.

const rules = require('./rules');
const bots = require('./bots');

module.exports = function createCribbageGame(deps) {
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

  const PLAYER_COUNT = 2;
  const MIN_TARGET_SCORE = 61;
  const MAX_TARGET_SCORE = 121;
  const DEFAULT_TARGET_SCORE = 121;
  const BOT_MOVE_DELAY_MS = Math.max(0, parseInt(process.env.BOT_MOVE_DELAY_MS || '900', 10));

  function normalizeMatchSettings(payload) {
    return {
      targetScore: clampInteger(payload && payload.cribbageTargetScore, MIN_TARGET_SCORE, MAX_TARGET_SCORE, DEFAULT_TARGET_SCORE)
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
      hands: [[], []],
      showHands: [[], []],
      stub: [],
      crib: [],
      discardSubmitted: [false, false],
      starter: null,
      hisHeelsAwarded: false,
      handPointsThisHand: [0, 0],
      peg: null,
      show: null,
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
      io.to(player.id).emit('cribbageHand', {
        hand: table.game.hands[index],
        handNumber: table.game.handNumber,
        phase: table.game.phase,
        dealerIndex: table.game.dealerIndex
      });
    });
  }

  // Dealer rotates every hand (alternating, per rules.nextDealerIndex). The
  // dealer's crib is only scored last, at the end of the show phase - see
  // runShowStep()'s 'crib' step.
  function beginHand(table) {
    table.game.handNumber = (table.game.handNumber || 0) + 1;
    table.game.dealerIndex = table.game.handNumber === 1 ? 0 : rules.nextDealerIndex(table.game.dealerIndex);

    const deck = rules.createDeck();
    shuffle(deck);
    const dealt = rules.dealHands(deck);
    table.game.hands = dealt.hands;
    table.game.stub = dealt.stub;
    table.game.showHands = [[], []];
    table.game.crib = [];
    table.game.discardSubmitted = [false, false];
    table.game.starter = null;
    table.game.hisHeelsAwarded = false;
    table.game.handPointsThisHand = [0, 0];
    table.game.peg = null;
    table.game.show = null;
    table.game.phase = 'discard';

    io.to(table.id).emit('actionNotice', 'Hand ' + table.game.handNumber + '. Discard two cards to the crib.');
    sendHands(table);
    io.to(table.id).emit('cribbageDiscardPrompt', { handNumber: table.game.handNumber, dealerIndex: table.game.dealerIndex });
    emitTableState(table);
    maybeScheduleBotDiscards(table);
  }

  // Up to two bots may need to discard simultaneously (unlike pegging's single
  // active turn), so each gets its own independent timer rather than the
  // shared table.game.botTimer - same reasoning as Hearts' maybeScheduleBotPasses.
  function maybeScheduleBotDiscards(table) {
    table.players.forEach(function (player, index) {
      if (player.isBot && !table.game.discardSubmitted[index]) {
        setTimeout(function () {
          if (tables[table.id] !== table || !table.game || table.game.phase !== 'discard' || table.game.discardSubmitted[index]) {
            return;
          }
          const isOwnCrib = index === table.game.dealerIndex;
          const choice = bots.chooseBotDiscard(table.game.hands[index], isOwnCrib);
          performDiscard(table, player.id, choice.cards);
        }, BOT_MOVE_DELAY_MS);
      }
    });
  }

  function performDiscard(table, actingId, cards) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'discard') {
      io.to(actingId).emit('cribbageDiscardResult', { success: false, message: 'Discarding is not open right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex < 0) {
      return;
    }

    if (table.game.discardSubmitted[playerIndex]) {
      io.to(actingId).emit('cribbageDiscardResult', { success: false, message: 'You already submitted your discard' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (!rules.isValidDiscard(hand, cards)) {
      io.to(actingId).emit('cribbageDiscardResult', { success: false, message: 'Select exactly two cards from your own hand' });
      return;
    }

    const result = rules.applyDiscard(hand, cards);
    table.game.hands[playerIndex] = result.remainingHand;
    table.game.crib = table.game.crib.concat(result.discarded);
    table.game.discardSubmitted[playerIndex] = true;

    io.to(actingId).emit('cribbageDiscardResult', { success: true, message: 'Discard submitted.' });
    emitTableState(table);
    maybeResolveDiscard(table);
  }

  function maybeResolveDiscard(table) {
    if (table.game.discardSubmitted.some(function (submitted) { return !submitted; })) {
      return;
    }
    io.to(table.id).emit('actionNotice', 'Both players have discarded. Cutting for the starter...');
    resolveDiscardAndCut(table);
  }

  // The stub handed off from dealHands() is already a shuffled remainder of
  // the deck, so taking its first card (rules.revealStarter) IS a fair cut -
  // see that function's own header comment in rules.js.
  function resolveDiscardAndCut(table) {
    // Snapshot each player's post-discard 4-card hand before pegging starts
    // mutating table.game.hands down to empty - the show phase reads from
    // showHands, not hands (see runShowStep()).
    table.game.showHands = table.game.hands.map(function (hand) { return hand.slice(); });

    const revealed = rules.revealStarter(table.game.stub);
    table.game.starter = revealed.starter;
    table.game.stub = revealed.remainingStub;

    const hisHeels = rules.isHisHeels(table.game.starter);
    table.game.hisHeelsAwarded = hisHeels;

    io.to(table.id).emit('cribbageCutResult', {
      starter: table.game.starter,
      hisHeels: hisHeels,
      dealerName: table.players[table.game.dealerIndex].name
    });

    if (hisHeels) {
      const dealerIndex = table.game.dealerIndex;
      io.to(table.id).emit('actionNotice', table.players[dealerIndex].name + ' scores 2 for his heels (Jack starter).');
      if (awardPoints(table, dealerIndex, 2)) {
        return;
      }
    }

    beginPegPhase(table);
  }

  // Central scoring choke point: every scoring site (pegging plays, Go/31
  // points, his heels, each show step) funnels through here, then
  // immediately checks for game-over - Cribbage ends the instant either
  // score reaches the target, even mid-peg or mid-show, not just at hand
  // boundaries (unlike Hearts/Spades, which only check once per hand). The
  // boolean return tells the caller whether to bail out of any further phase
  // advancement.
  function awardPoints(table, playerIndex, points) {
    const player = table.players[playerIndex];
    table.scores[player.name] = (table.scores[player.name] || 0) + points;
    table.game.handPointsThisHand[playerIndex] = (table.game.handPointsThisHand[playerIndex] || 0) + points;
    // Push the updated score to every client immediately - sighted players
    // see the peg move (renderCribbageBoard/renderCribbageStatus both read
    // player.score off tableState) the instant it's earned, not just at the
    // next incidental emitTableState() call (e.g. the next hand/phase). Blind
    // players already hear this via the actionNotice/srSpeak announcements
    // each awardPoints() caller sends alongside the score - this closes the
    // matching visual gap.
    emitTableState(table);
    return maybeEndGameMidHand(table);
  }

  function maybeEndGameMidHand(table) {
    const settings = getMatchSettings(table);
    const cumulative = table.players.map(function (player) { return table.scores[player.name] || 0; });
    if (!rules.isGameOver(cumulative, settings.targetScore)) {
      return false;
    }

    const winnerIndex = rules.getWinnerIndex(cumulative);
    const winner = table.players[winnerIndex];
    const finalScores = table.players.map(function (player) {
      return { name: player.name, totalPoints: table.scores[player.name] || 0 };
    });

    io.to(table.id).emit('cribbageGameOver', { winner: winner.name, scores: finalScores });
    io.to(table.id).emit('actionNotice', 'Game over. ' + winner.name + ' wins with ' + (table.scores[winner.name] || 0) + ' points.');

    table.players.forEach(function (player, index) {
      recordGameResult(player.accountId, 'cribbage', index === winnerIndex ? 'win' : 'loss');
    });

    table.status = 'waiting';
    table.game = null;
    emitTableState(table);
    emitLobbySnapshotAll();
    return true;
  }

  function beginPegPhase(table) {
    table.game.phase = 'peg';
    const nonDealerIndex = 1 - table.game.dealerIndex;
    table.game.peg = {
      segment: [],
      count: 0,
      turnIndex: nonDealerIndex,
      stuckIndex: null,
      lastPlayerIndex: null,
      cardsPlayedThisHand: 0
    };
    emitTableState(table);
    emitCribbagePegState(table, null);
  }

  function buildPublicPegSegment(table) {
    return table.game.peg.segment.map(function (entry) {
      const player = table.players[entry.playerIndex];
      return { playerId: player ? player.id : null, playerName: player ? player.name : '', card: entry.card };
    });
  }

  function describePegScore(scoring) {
    const parts = [];
    if (scoring.fifteenPoints) {
      parts.push('Fifteen for ' + scoring.fifteenPoints + '.');
    }
    if (scoring.thirtyOnePoints) {
      parts.push('Thirty-one for ' + scoring.thirtyOnePoints + '.');
    }
    if (scoring.pairPoints) {
      const label = scoring.pairSize === 2 ? 'Pair' : (scoring.pairSize === 3 ? 'Three of a kind' : 'Four of a kind');
      parts.push(label + ' for ' + scoring.pairPoints + '.');
    }
    if (scoring.runPoints) {
      parts.push('Run of ' + scoring.runLength + ' for ' + scoring.runPoints + '.');
    }
    return parts.join(' ');
  }

  // lastEvent (optional): { type: 'play', playerIndex, playerName, card, scoreText }
  // or { type: 'go', playerIndex, playerName } - describes the action that
  // just happened within the still-open current segment. Segment resets
  // (exact 31 or a mutual Go) get their own dedicated cribbagePegRoundResult
  // broadcast instead (see performPegPlay()/advancePegTurn()), so lastEvent
  // is always null right after one of those.
  function buildPegMessage(table, recipientIndex, lastEvent) {
    const parts = [];
    if (lastEvent) {
      if (lastEvent.type === 'play') {
        if (lastEvent.playerIndex !== recipientIndex) {
          parts.push(lastEvent.playerName + ' plays ' + rules.cardName(lastEvent.card) + '.');
        }
        if (lastEvent.scoreText) {
          parts.push(lastEvent.scoreText);
        }
      } else if (lastEvent.type === 'go') {
        if (lastEvent.playerIndex !== recipientIndex) {
          parts.push(lastEvent.playerName + ' says Go.');
        }
      }
    }
    if (recipientIndex === table.game.peg.turnIndex) {
      parts.push(table.game.peg.count > 0 ? ('Your turn. Count is ' + table.game.peg.count + '.') : 'Your turn to lead.');
    }
    return parts.length ? parts.join(' ') : null;
  }

  function emitCribbagePegState(table, lastEvent) {
    const peg = table.game.peg;
    const turnPlayer = table.players[peg.turnIndex];
    if (!turnPlayer) {
      return;
    }

    table.players.forEach(function (player, index) {
      const payload = {
        phase: 'peg',
        handNumber: table.game.handNumber,
        dealerIndex: table.game.dealerIndex,
        count: peg.count,
        segment: buildPublicPegSegment(table),
        turnPlayerId: turnPlayer.id,
        turnPlayerName: turnPlayer.name,
        message: buildPegMessage(table, index, lastEvent)
      };

      if (index === peg.turnIndex) {
        payload.legalCards = rules.getLegalPeggingPlays(table.game.hands[index], peg.count);
        payload.mustGo = payload.legalCards.length === 0;
      }

      io.to(player.id).emit('cribbagePegState', payload);
    });

    maybeScheduleBotPeg(table);
  }

  function maybeScheduleBotPeg(table) {
    if (!table || !table.game || table.status !== 'in_game' || table.game.phase !== 'peg') {
      return;
    }
    const currentPlayer = table.players[table.game.peg.turnIndex];
    if (currentPlayer && currentPlayer.isBot) {
      scheduleBotAction(table, function () {
        runBotPeg(table, currentPlayer.id);
      });
    }
  }

  function runBotPeg(table, botId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'peg') {
      return;
    }
    const playerIndex = getPlayerIndex(table, botId);
    if (playerIndex !== table.game.peg.turnIndex) {
      return;
    }
    const bot = table.players[playerIndex];
    if (!bot || !bot.isBot) {
      return;
    }
    const peg = table.game.peg;
    const lastCard = peg.segment.length ? peg.segment[peg.segment.length - 1].card : null;
    const card = bots.choosePegPlay(table.game.hands[playerIndex], peg.count, lastCard);
    if (card) {
      performPegPlay(table, botId, card);
    } else {
      performPegGo(table, botId);
    }
  }

  function performPegPlay(table, actingId, card) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'peg') {
      io.to(actingId).emit('cribbagePegPlayResult', { success: false, message: 'Unable to play a card right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.peg.turnIndex) {
      io.to(actingId).emit('cribbagePegPlayResult', { success: false, message: 'It is not your turn' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (typeof card !== 'string' || hand.indexOf(card) === -1) {
      io.to(actingId).emit('cribbagePegPlayResult', { success: false, message: 'That card is not in your hand' });
      return;
    }

    if (!rules.isLegalPeggingPlay(hand, table.game.peg.count, card)) {
      io.to(actingId).emit('cribbagePegPlayResult', { success: false, message: 'That card would push the count past 31' });
      return;
    }

    hand.splice(hand.indexOf(card), 1);
    const peg = table.game.peg;
    peg.segment.push({ playerIndex: playerIndex, card: card });
    peg.count += rules.cardValue(card);
    peg.cardsPlayedThisHand += 1;
    peg.lastPlayerIndex = playerIndex;

    const player = table.players[playerIndex];
    const scoring = rules.scoreTrailingPlay(peg.segment.map(function (entry) { return entry.card; }));
    const scoreText = describePegScore(scoring);

    io.to(actingId).emit('cribbagePegPlayResult', { success: true, card: card, message: '' });
    io.to(player.id).emit('cribbageHand', {
      hand: hand, handNumber: table.game.handNumber, phase: table.game.phase, dealerIndex: table.game.dealerIndex
    });

    if (scoring.total > 0) {
      io.to(table.id).emit('actionNotice', player.name + ' scores ' + scoring.total + ' pegging. ' + scoreText);
      if (awardPoints(table, playerIndex, scoring.total)) {
        return;
      }
    }

    if (peg.count === 31) {
      const segmentSnapshot = buildPublicPegSegment(table);
      peg.segment = [];
      peg.count = 0;
      peg.stuckIndex = null;
      peg.turnIndex = 1 - playerIndex;
      io.to(table.id).emit('cribbagePegRoundResult', {
        reason: 'thirtyOne', scorerName: player.name, points: scoring.thirtyOnePoints, segment: segmentSnapshot
      });
      maybeAdvanceToShow(table);
      return;
    }

    advancePegTurn(table, playerIndex, false, { type: 'play', playerIndex: playerIndex, playerName: player.name, card: card, scoreText: scoreText });
  }

  function performPegGo(table, actingId) {
    if (!table || table.status !== 'in_game' || !table.game || table.game.phase !== 'peg') {
      io.to(actingId).emit('cribbagePegGoResult', { success: false, message: 'Unable to say Go right now' });
      return;
    }

    const playerIndex = getPlayerIndex(table, actingId);
    if (playerIndex !== table.game.peg.turnIndex) {
      io.to(actingId).emit('cribbagePegGoResult', { success: false, message: 'It is not your turn' });
      return;
    }

    const hand = table.game.hands[playerIndex];
    if (rules.getLegalPeggingPlays(hand, table.game.peg.count).length > 0) {
      io.to(actingId).emit('cribbagePegGoResult', { success: false, message: 'You still have a legal play' });
      return;
    }

    const player = table.players[playerIndex];
    io.to(actingId).emit('cribbagePegGoResult', { success: true, message: '' });
    advancePegTurn(table, playerIndex, true, { type: 'go', playerIndex: playerIndex, playerName: player.name });
  }

  // actorWasStuck distinguishes "actor just legally played a card" (false -
  // never itself triggers a Go, since a legal play was possible) from "actor
  // just said Go because they had no legal play" (true - only this path can
  // complete a mutual Go). See this module's header/CLAUDE.md notes on the
  // pegging turn engine for the full walk-through.
  function advancePegTurn(table, actorIndex, actorWasStuck, lastEvent) {
    const peg = table.game.peg;
    const otherIndex = 1 - actorIndex;

    if (!actorWasStuck) {
      const otherLegal = rules.getLegalPeggingPlays(table.game.hands[otherIndex], peg.count);
      if (otherLegal.length) {
        peg.turnIndex = otherIndex;
        peg.stuckIndex = null;
        emitCribbagePegState(table, lastEvent);
        return;
      }
      // The other player has nothing they could legally play right now - skip
      // straight past their turn (mark them stuck) rather than forcing them to
      // click Go on a turn they can never act on; the still-live actor keeps
      // playing until they too run out of legal cards.
      peg.stuckIndex = otherIndex;
      peg.turnIndex = actorIndex;
      emitCribbagePegState(table, lastEvent);
      return;
    }

    if (peg.stuckIndex === otherIndex) {
      // Both players are now confirmed stuck in a row - that's the Go.
      const scorerIndex = peg.lastPlayerIndex;
      const scorer = table.players[scorerIndex];
      const segmentSnapshot = buildPublicPegSegment(table);
      io.to(table.id).emit('actionNotice', scorer.name + ' scores 1 for Go.');
      if (awardPoints(table, scorerIndex, 1)) {
        return;
      }
      io.to(table.id).emit('cribbagePegRoundResult', { reason: 'go', scorerName: scorer.name, points: 1, segment: segmentSnapshot });
      peg.segment = [];
      peg.count = 0;
      peg.stuckIndex = null;
      peg.turnIndex = 1 - scorerIndex;
      maybeAdvanceToShow(table);
      return;
    }

    peg.stuckIndex = actorIndex;
    peg.turnIndex = otherIndex;
    emitCribbagePegState(table, lastEvent);
  }

  function maybeAdvanceToShow(table) {
    if (table.game.peg.cardsPlayedThisHand >= 8) {
      beginShowPhase(table);
      return;
    }
    emitCribbagePegState(table, null);
  }

  function beginShowPhase(table) {
    table.game.phase = 'show';
    table.game.show = { step: 'nonDealer', pendingAcks: null, lastPayload: null };
    emitTableState(table);
    runShowStep(table);
  }

  // Sequential ack-gated steps in the required order: non-dealer's hand,
  // dealer's hand, then the dealer's crib (counted last) - each scored
  // against the shared starter (rules.scoreFiveCards). Game-over is checked
  // after every step via awardPoints()/maybeEndGameMidHand().
  function runShowStep(table) {
    const show = table.game.show;
    const nonDealerIndex = 1 - table.game.dealerIndex;

    let ownerIndex, cards, isCrib, label;
    if (show.step === 'nonDealer') {
      ownerIndex = nonDealerIndex;
      cards = table.game.showHands[nonDealerIndex];
      isCrib = false;
      label = 'hand';
    } else if (show.step === 'dealer') {
      ownerIndex = table.game.dealerIndex;
      cards = table.game.showHands[table.game.dealerIndex];
      isCrib = false;
      label = 'hand';
    } else {
      ownerIndex = table.game.dealerIndex;
      cards = table.game.crib;
      isCrib = true;
      label = 'crib';
    }

    const owner = table.players[ownerIndex];
    const breakdown = rules.scoreFiveCards(cards, table.game.starter, isCrib);

    finishShowStepScoring(table, ownerIndex, cards, label, breakdown.total);
  }

  function finishShowStepScoring(table, ownerIndex, cards, label, points) {
    const show = table.game.show;
    const owner = table.players[ownerIndex];

    io.to(table.id).emit('actionNotice', owner.name + "'s " + label + ' scores ' + points + '.');

    if (points > 0) {
      if (awardPoints(table, ownerIndex, points)) {
        return;
      }
    }

    const payload = {
      step: show.step,
      ownerId: owner.id,
      ownerName: owner.name,
      cards: cards.slice(),
      starter: table.game.starter,
      label: label,
      points: points,
      ownerTotal: table.scores[owner.name] || 0
    };

    show.lastPayload = payload;
    show.pendingAcks = {};
    table.players.forEach(function (player) {
      if (!player.isBot) {
        show.pendingAcks[player.id] = true;
      }
    });

    emitTableState(table);
    io.to(table.id).emit('cribbageShowStep', payload);
    tryAdvanceShowStep(table);
  }

  function tryAdvanceShowStep(table) {
    if (!table.game || !table.game.show || !table.game.show.pendingAcks) {
      return;
    }
    if (Object.keys(table.game.show.pendingAcks).length > 0 || table.status !== 'in_game') {
      return;
    }

    const show = table.game.show;
    show.pendingAcks = null;

    if (show.step === 'nonDealer') {
      show.step = 'dealer';
      runShowStep(table);
    } else if (show.step === 'dealer') {
      show.step = 'crib';
      runShowStep(table);
    } else {
      finishHand(table);
    }
  }

  // By the time this runs, no awardPoints() call this hand triggered
  // game-over (every caller already bailed out if it had), so there is no
  // gameOver branch to check here, unlike Hearts'/Spades' finishHand().
  function finishHand(table) {
    table.game.phase = 'hand_complete';

    const scoreRows = table.players.map(function (player, index) {
      return {
        name: player.name,
        handPoints: table.game.handPointsThisHand[index] || 0,
        totalPoints: table.scores[player.name] || 0
      };
    });

    io.to(table.id).emit('cribbageHandSummary', {
      handNumber: table.game.handNumber,
      dealerIndex: table.game.dealerIndex,
      starter: table.game.starter,
      hisHeelsAwarded: table.game.hisHeelsAwarded,
      scores: scoreRows
    });

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
      return { cribbage: null };
    }

    const extra = {
      phase: table.game.phase,
      handNumber: table.game.handNumber,
      dealerIndex: table.game.dealerIndex,
      starter: table.game.starter,
      hisHeelsAwarded: table.game.hisHeelsAwarded,
      discardSubmitted: table.game.discardSubmitted ? table.game.discardSubmitted.slice() : [false, false]
    };

    if (table.game.phase === 'peg' && table.game.peg) {
      const turnPlayer = table.players[table.game.peg.turnIndex];
      extra.peg = {
        count: table.game.peg.count,
        segment: buildPublicPegSegment(table),
        turnPlayerId: turnPlayer ? turnPlayer.id : null,
        turnPlayerName: turnPlayer ? turnPlayer.name : ''
      };
    }

    if (table.game.show && table.game.show.lastPayload) {
      extra.show = table.game.show.lastPayload;
    }

    // Crib contents stay hidden from tableState until the show phase's own
    // 'crib' step (or the hand is fully complete) - even the dealer, who owns
    // the crib, shouldn't see it early. See this module's header comment.
    const cribRevealed = table.game.phase === 'hand_complete' || (table.game.show && table.game.show.step === 'crib');
    extra.crib = cribRevealed ? table.game.crib.slice() : null;

    return { cribbage: extra };
  }

  function getPlayerSummaryFields(table, player) {
    const index = table.players.indexOf(player);
    return {
      cardCount: table.status === 'in_game' && table.game && table.game.hands[index] ? table.game.hands[index].length : 0,
      score: typeof table.scores[player.name] === 'number' ? table.scores[player.name] : 0,
      roundPoints: table.game && table.game.handPointsThisHand ? (table.game.handPointsThisHand[index] || 0) : 0
    };
  }

  function onPlayerRemoved(table, removedIndex, playerName) {
    if (table.status !== 'in_game' || !table.game) {
      return;
    }
    // Cribbage is fixed at exactly two seats and its state (hands/crib/peg
    // turn order) is keyed by seat index, so losing a seat mid-hand can't be
    // patched up - same reasoning as Hearts'/Spades' onPlayerRemoved(). The
    // disconnect-grace system (shared, unaffected by this hook) already gives
    // a departing player a window to reconnect into this same seat first.
    io.to(table.id).emit('actionNotice', playerName + ' left the game. The Cribbage hand cannot continue with fewer than two players.');
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

    if (table.game.show && table.game.show.pendingAcks && table.game.show.pendingAcks[previousSocketId]) {
      table.game.show.pendingAcks[player.id] = true;
      delete table.game.show.pendingAcks[previousSocketId];
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

    io.to(player.id).emit('cribbageHand', {
      hand: table.game.hands[index] || [],
      handNumber: table.game.handNumber,
      phase: table.game.phase,
      dealerIndex: table.game.dealerIndex
    });

    if (table.game.phase === 'peg') {
      emitCribbagePegState(table, null);
    } else if (table.game.phase === 'discard') {
      io.to(player.id).emit('cribbageDiscardPrompt', { handNumber: table.game.handNumber, dealerIndex: table.game.dealerIndex });
    } else if (table.game.phase === 'show' && table.game.show && table.game.show.lastPayload) {
      // Resend the last-broadcast payload verbatim rather than recomputing -
      // recomputing would call runShowStep() again and double-score via
      // awardPoints().
      io.to(player.id).emit('cribbageShowStep', table.game.show.lastPayload);
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
      if (Array.isArray(g.showHands)) {
        table.game.showHands = g.showHands.map(function (hand) { return hand.slice(); });
      }
      if (typeof g.dealerIndex === 'number') {
        table.game.dealerIndex = g.dealerIndex;
      }
      if (typeof g.phase === 'string') {
        table.game.phase = g.phase;
      }
      if (typeof g.starter === 'string') {
        table.game.starter = g.starter;
      }
      if (Array.isArray(g.crib)) {
        table.game.crib = g.crib.slice();
      }
      if (Array.isArray(g.stub)) {
        table.game.stub = g.stub.slice();
      }
      if (typeof g.hisHeelsAwarded === 'boolean') {
        table.game.hisHeelsAwarded = g.hisHeelsAwarded;
      }
      if (Array.isArray(g.discardSubmitted)) {
        table.game.discardSubmitted = g.discardSubmitted.slice();
      }
      if (g.peg) {
        table.game.peg = Object.assign(
          { segment: [], count: 0, turnIndex: 0, stuckIndex: null, lastPlayerIndex: null, cardsPlayedThisHand: 0 },
          table.game.peg || {},
          g.peg
        );
      }
      if (g.show) {
        table.game.show = Object.assign(
          { step: 'nonDealer', pendingAcks: null, lastPayload: null },
          table.game.show || {},
          g.show
        );
      }
      if (Array.isArray(g.handPointsThisHand)) {
        table.game.handPointsThisHand = g.handPointsThisHand.slice();
      }
    }

    if (payload.emitCribbagePegState) {
      emitCribbagePegState(table, null);
    }
  }

  function registerSocketHandlers(socket) {
    socket.on('cribbageSubmitDiscard', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'cribbage') {
        return;
      }
      performDiscard(table, socket.id, payload && payload.cards);
    });

    socket.on('cribbagePlayCard', function (payload) {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'cribbage') {
        return;
      }
      performPegPlay(table, socket.id, payload && payload.card);
    });

    socket.on('cribbagePegGo', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'cribbage') {
        return;
      }
      performPegGo(table, socket.id);
    });

    socket.on('cribbageAckShow', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'cribbage' || !table.game || !table.game.show || !table.game.show.pendingAcks) {
        return;
      }
      delete table.game.show.pendingAcks[socket.id];
      tryAdvanceShowStep(table);
    });

    socket.on('cribbageAckHandSummary', function () {
      const table = findTableBySocket(socket);
      if (!table || table.gameType !== 'cribbage' || !table.game || !table.game.pendingHandAcks) {
        return;
      }
      delete table.game.pendingHandAcks[socket.id];
      tryBeginNextHand(table);
    });
  }

  return {
    type: 'cribbage',
    name: 'Cribbage',
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
