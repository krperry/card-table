# Rummy Rules

## Objective

Rummy is played by 2-6 players with a standard 52-card deck plus its 2
Jokers (54 cards total). Each turn, a player draws a card, may lay down any number of melds or add
cards to melds already on the table, and must then discard to end their
turn. The first player to empty their hand **goes out** and wins the hand,
scoring points equal to the total deadwood left in every other player's
hand. Hands repeat until a player's cumulative score reaches the table's
configured target score.

This implementation follows basic Rummy as described on
[pagat.com](https://www.pagat.com/rummy/rummy.html). A few points pagat.com
leaves open to house-rule variation are called out explicitly below.

## Setup

- Rummy seats 2-6 players. If a host starts a table with only one human
  seated, exactly one computer player is added to make a legal two-player
  game; tables of three or more human players start as-is.
- Each player is dealt **10 cards** in a two-player game, or **7 cards** in
  a game of three to six players.
- One further card is turned face-up to start the discard pile. The rest of
  the deck becomes the stock.
- The player to the dealer's left goes first; the dealer seat rotates one
  seat every hand.

## Melds

A **meld** is a group of three or more cards laid face-up on the table.
There are two kinds:

- **Set**: three or four cards of the same rank, in different suits (e.g.
  7♣ 7♦ 7♥).
- **Run**: three or more consecutive cards of the same suit.

**House rule:** runs are **ace-low only** in this implementation - A-2-3 is
a legal run, but Q-K-A is not. Pagat.com does not pin this down definitively
either way; ace-low-only is the simplest, most common basic-Rummy
convention and avoids an "ace is both high and low" ambiguity.

**House rule:** unlike Gin Rummy, there is **no minimum point requirement**
to lay down your first meld - any valid set or run may be melded the moment
you hold one.

Melds are public: every player can see every meld on the table at all
times.

## Jokers

The deck includes both Jokers. A Joker is wild: it can stand in for any card
of the rank or suit a set or run needs, whether you're melding it from your
hand or laying it off onto a meld already on the table. A meld still needs
at least one real card to establish what it is - a group made entirely of
Jokers isn't allowed, since there would be nothing to say what rank or suit
it represents.

**House rule:** a Joker left in your hand when a hand ends counts as **15
deadwood points** - more than any real card - since it's the most valuable
card to be caught holding. Basic Rummy sources vary on the exact penalty
value; 15 is a common convention and keeps the game's existing pip-value
deadwood scale (Ace 1, number cards their pip value, face cards 10) simply
extended upward for the Joker.

**Swapping a Joker back:** if you lay off a real card that exactly matches
what a Joker on the table is currently standing in for, the swap happens
automatically - the Joker comes off the meld and into your hand, and your
real card takes its place. For example, a run of A♥ 2♥ Joker♥ (the Joker
standing in for 3♥) accepts a laid-off 3♥ this way; a set of 5♥ 5♣ Joker♠
accepts a laid-off 5♦ the same way. This works even when a set already has
four cards, since the meld's size doesn't change - only the Joker leaves and
the real card takes its slot.

## Laying Off

Once a meld is on the table, any player may **lay off** matching cards onto
it during their own turn - extending a set with a fourth matching card, or
extending a run at either end.

**House rule:** you may lay off onto **any** player's melds, including your
own earlier melds - not just melds someone else laid down. Pagat.com does
not resolve this point definitively; allowing lay-offs onto any meld keeps
the rule simple and matches this implementation's keyboard-accessible
design (see below).

A card is always attached to whichever meld group it legally extends -
there is no need to specify a particular group when more than one exists
for the same player, since in practice a card can extend at most one group.

## Taking a Turn

1. **Draw** - take either the top card of the stock, or the top card of the
   discard pile.
2. **Act** (optional, any number of times) - meld any set or run from your
   hand, and/or lay off cards onto any player's existing melds.
3. **Discard** - place one card face-up on the discard pile, ending your
   turn. If melding or laying off empties your hand before you would
   otherwise discard, the hand ends immediately without a discard - you
   have gone out.

If the stock runs out, the discard pile (except its own top card) is
reshuffled into a new stock. In the extremely rare case that the discard
pile also has nothing left to reshuffle, the hand ends immediately with no
winner and no score change.

## Going Out and Scoring

The first player to empty their hand goes out and wins the hand.
**Deadwood** is the point value of the cards left in a losing player's
hand: number cards score their pip value, face cards (Jack, Queen, King)
score 10, and Aces score 1 (never 11).

The player who went out scores the **sum of every other player's
deadwood**. Everyone else scores 0 for that hand. These points accumulate
onto each player's running match total.

## Winning

Hands repeat, with the dealer rotating one seat each time, until a hand
pushes some player's cumulative score to the table's configured target
score (host-configurable, default 500). The player with the highest total
score at that point wins the match.

## Accessibility Note

Because melds are visible to every player at a glance, but there is no
sighted equivalent for a screen-reader user, this implementation adds a
dedicated keyboard scheme: press a number key **1** through **6** at any
time to have that seat's melds read aloud and set as your lay-off target,
then press **L** to lay off your marked cards onto it. See the in-game help
overlay (press **?**) for the complete list of keyboard shortcuts.
