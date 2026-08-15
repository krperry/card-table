# Spades Rules

## Objective

Spades is played by two fixed partnerships of two players each. Each hand,
every player bids how many tricks they expect to take, and each team tries
to take at least as many tricks as their combined bid. The game ends when a
hand pushes either team's cumulative score to the table's configured target
score; the team with the higher score at that point wins.

## Setup

- Spades is always played by exactly four players in two fixed
  partnerships: seats 1 & 3 are partners, and seats 2 & 4 are partners. If
  fewer than four have joined when the host starts the table, computer
  players fill the remaining seats.
- A standard 52-card deck is shuffled and dealt out evenly, 13 cards to
  each player.
- Spades are always trump - the highest-ranked spade wins a trick no
  matter what suit was led.

## Dealing and Bidding Order

- The dealer rotates one seat every hand.
- The player to the dealer's left bids first, and play proceeds in turn
  order from there. Each player hears every bid placed before them.
- Each player bids a number of tricks they expect to take, from 0 to 13.
  A bid of **0 is Nil** - a bid to take zero tricks for the hand.
- Once all four players have bid, the player to the dealer's left leads
  the first trick.

## Playing a Trick

- Play continues in turn order. Each player must follow the suit that was
  led if they have a card of that suit.
- If a player has no card of the led suit, they may play any card,
  including a spade.
- Spades cannot be led until spades have been "broken" - meaning a spade
  has already been played (led or discarded) in an earlier trick.
  Exception: if a player's hand contains only spades, they may lead a
  spade even if spades have not yet broken.
- The trick is won by the highest-ranked spade played, if any spade was
  played at all - even if spades were not led. If no spade was played,
  the trick is won by the highest-ranked card of the suit that was led.
- The winner of a trick leads the next one.

## Scoring

At the end of each hand, each team's combined bid and combined tricks
taken are compared:

- **Contract made** (tricks taken &ge; combined bid): the team scores 10
  points for every trick bid, plus 1 point for every trick taken beyond
  the bid (an "overtrick" or "bag").
- **Contract failed** (tricks taken &lt; combined bid): the team loses 10
  points for every trick bid. No bags are added.

### Nil Bids

A player who bid Nil (0) is scored separately from their partner's
contract:

- If they take **zero** tricks, their team gains a **+100** point bonus.
- If they take **one or more** tricks, their team loses **100** points.

This Nil bonus or penalty applies in addition to whatever the team's
combined non-Nil contract scores.

### Bags

Overtricks ("bags") accumulate for each team, hand over hand. Once a
team's running bag total reaches **10**, the team loses **100** points
and 10 bags are subtracted from their running total (any bags beyond 10
carry forward toward the next penalty).

## Winning

The game ends as soon as a hand brings either team's cumulative score to
the table's configured target score (host-configurable, default 500).
The team with the **higher** total score at that point wins the game.
