# Cribbage Rules

## Overview

Cribbage is a two-player card game played over a series of hands, combining
a card-play phase ("pegging") with a hand-scoring phase (the "show"). Points
are scored throughout both phases. The game ends the instant either
player's score reaches the table's configured target - even in the middle
of a hand, not just when a hand finishes.

## The Deal

- Each player is dealt 6 cards.
- Each player then discards 2 cards face-down into the dealer's **crib** - a
  fifth, hidden hand that belongs to the dealer and is scored last, after
  both players' hands. Discarding leaves each player with 4 cards.
- The dealer alternates every hand.

## The Starter

- After both players discard, a **starter** card is revealed from the top
  of the remaining deck.
- If the starter is a **Jack**, the dealer immediately scores **2 points**
  for "his heels."

## Pegging (the Play)

- The non-dealer leads first. Players then alternate playing one card at a
  time face-up, announcing a running count of the cards played so far. The
  count may never be allowed to exceed **31**.
- **Fifteen**: if a play brings the count to exactly 15, the player scores
  **2 points**.
- **Thirty-one**: if a play brings the count to exactly 31, the player
  scores **2 points**, and the count immediately resets to zero.
- **Pairs**: if a play matches the rank of the card just played before it,
  the player scores **2 points** for a pair, **6** for three in a row
  (three of a kind), or **12** for four in a row.
- **Runs**: if the most recently played cards form a run of 3 or more
  consecutive ranks - in any order - the player scores 1 point per card in
  the run.
- **Go**: if a player cannot play a card without exceeding 31, they say
  "Go." Their opponent keeps playing until they, too, cannot continue.
  Whoever played the last card before both players were stuck scores
  **1 point** for the Go (or the usual 2 points if that last card brought
  the count to exactly 31 instead). The count then resets to zero and play
  continues until all 8 cards (4 from each player) have been played.

## The Show (Counting)

Once all cards have been played, each hand is counted in this order:
first the non-dealer's hand, then the dealer's hand, then the dealer's
crib - each counted against the shared starter card.

- **Fifteens**: every combination of cards (two or more) that sums to
  exactly 15 scores 2 points.
- **Pairs**: every pair of same-rank cards scores 2 points (6 for three of
  a kind, 12 for four of a kind).
- **Runs**: a run of 3 or more consecutive ranks scores 1 point per card. A
  duplicated rank within a run (a "double run") scores the run multiple
  times - once for each way to pick one card per rank in the run - in
  addition to the pair points for the duplicate.
- **Flush**: if all 4 cards in a hand share the same suit, that hand scores
  4 points, or 5 if the starter also matches. A crib flush is stricter - it
  requires all 4 crib cards **and** the starter to match suit for 5 points;
  there is no partial credit for a crib.
- **Nobs**: if a hand contains the Jack of the same suit as the starter, it
  scores 1 point.

## Muggins (optional)

Some tables enable "Muggins," an optional house rule (off by default). When
enabled, if a player under-counts their hand or crib during the show, their
opponent has a short window to claim the missed points for themselves
instead. Points that go unclaimed are simply lost.

## Winning

The game ends the instant either player's cumulative score reaches the
table's configured target - 121 points by default, or 61 points for a
shorter game. Reaching the target ends the game immediately, even in the
middle of pegging or the show, not just at the end of a hand. The player
with the higher score at that moment wins.
