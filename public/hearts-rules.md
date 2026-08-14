# Hearts Rules

## Objective

Score as few points as possible. Each Heart is worth 1 point and the
Queen of Spades is worth 13 points. The game ends when a hand pushes
any player's cumulative score to the table's configured points-to-end
threshold; the player with the lowest score at that point wins.

## Setup

- Hearts is always played by exactly four players. If fewer than four
  have joined when the host starts the table, computer players fill
  the remaining seats.
- A standard 52-card deck is shuffled and dealt out evenly, 13 cards
  to each player.

## Passing

Before most hands begin, each player chooses three cards from their
hand and passes them to another player. The direction rotates hand to
hand in a fixed four-hand cycle:

- Hand 1: pass left
- Hand 2: pass right
- Hand 3: pass across
- Hand 4: hold (no cards are passed)

This cycle then repeats for hand 5, 6, 7, 8, and so on.

## Starting a Hand

Whoever holds the 2 of Clubs after passing leads the very first trick
of the hand and must play the 2 of Clubs.

## Playing a Trick

- Play continues clockwise. Each player must follow the suit that was
  led if they have a card of that suit.
- If a player has no card of the led suit, they may play any card,
  including a Heart or the Queen of Spades.
- The trick is won by whoever played the highest-ranked card of the
  suit that was led. Off-suit cards, including any Hearts played when
  void in the led suit, can never win a trick.
- The winner of a trick leads the next one.

## Hearts Breaking

- Hearts cannot be led until Hearts have been "broken" - meaning a
  Heart has already been played (discarded off-suit) in an earlier
  trick.
- Exception: if a player's hand contains only Hearts, they may lead a
  Heart even if Hearts have not yet broken.

## First-Trick Restrictions

On the very first trick of the hand:

- No Heart may be played.
- The Queen of Spades may not be played.
- These cards may only be played on the first trick if a player has
  no other legal card in hand (for example, no card of the led suit
  and nothing else safe to discard).

## Scoring

At the end of each hand, every card a player captured in tricks they
won is scored:

- Each Heart is worth 1 point.
- The Queen of Spades is worth 13 points.
- All other cards are worth 0 points.

## Shooting the Moon

If a single player captures all 13 Hearts and the Queen of Spades in
one hand (26 points), they "shoot the moon": that player receives 0
points for the hand, and every other player receives 26 points
instead.

## Winning

The game ends as soon as a hand brings any player's cumulative score
to the table's configured points-to-end-game total (host-configurable,
default 100). The player with the **lowest** total score at that point
wins the game.
