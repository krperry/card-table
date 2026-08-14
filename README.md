# Accessible Card Table

An accessible, browser-based multiplayer card table built with Node.js, Express, and Socket.IO.

This repository is now a standalone project focused on a shared card-table platform where games are playable by everyone across keyboard, screen reader, mouse, and touch workflows.

## Project Direction

- This project is no longer maintained as a forked UNO-only codebase.
- It is now the foundation for a multi-game card table.
- Accessibility-first design is a core requirement for all current and future games.

## Current Status

- **Lumo** (UNO-like), **Hearts**, and **Spades** are fully implemented and playable.
- Lobby, table join/start flow, and account login are shared by every game.
- Cribbage is registered as an accessible preview; its gameplay isn't implemented yet.

## Planned Games

The following games are planned for addition:

- Cribbage
- More to come

## Architecture: shared platform + per-game modules

The table/lobby/account/networking/accessibility infrastructure is shared by every game; each game's rules, state, and UI live in their own module under `games/` (server) and `public/games/` (client):

- **Shared** (`server.js`, `public/main.js`): accounts/auth, table create/join/leave/kick, the disconnect-grace reconnect flow, the lobby/table-state broadcast dispatcher, screen navigation, ARIA live-region speech (`srSpeak`), and overlay/keyboard-binding scaffolding.
- **Lumo** (`games/lumo/`, `public/games/lumo/lumo-client.js`): the UNO-like deck, turn/stacking/Give-Plus-One rules, bot AI, and canvas-based board rendering. See `public/lumo-rules.md` for the house rules.
- **Hearts** (`games/hearts/`, `public/games/hearts/hearts-client.js`): a pure rules engine (`games/hearts/rules.js`, no networking - unit tested directly in `tests/hearts-rules.test.js`), simple bot heuristics (`games/hearts/bots.js`), and a native-button (not canvas) accessible UI for passing/trick play.
- **Spades** (`games/spades/`, `public/games/spades/spades-client.js`): a pure rules engine (`games/spades/rules.js`, no networking - unit tested directly in `tests/spades-rules.test.js`), simple bot heuristics (`games/spades/bots.js`), and a native-button accessible UI for turn-sequenced bidding and trick play. Unlike Hearts/Lumo, Spades is a fixed-partnership team game (seats 1 & 3 vs. seats 2 & 4) - scoring and game-over/winner detection operate on two team totals rather than four individual ones.
- **Standard playing-card art**: `public/images/playing-cards/` (52 cards + jokers/backs, `<RANK><SUIT>.svg` naming, e.g. `QS.svg` = Queen of Spades). Used by Hearts and Spades today; kept generic so future standard-deck games (Blackjack, Poker, ...) can reuse it. Lumo's own custom card art lives separately at `public/images/lumo/cards/`.
- **`games/registry.js`** assembles the game-module registry from factory functions - each game module is `module.exports = function createXGame(deps) { ...; return { type, name, minPlayers, maxPlayers, startGame, buildTableStateExtra, registerSocketHandlers, ... }; }`, where `deps` is a small set of shared primitives (`io`, `tables`, `shuffle`, `emitTableState`, ...) injected once at startup. `server.js`'s generic dispatchers (`buildTableState`, the `startGame` handler, `removePlayerFromTable`, `reclaimSeatAfterReconnect`) call into whichever module matches a table's `gameType`.
- **Adding a new game**: create `games/<name>/index.js` (factory returning the module interface above) and register it in `games/registry.js`; on the client, add a `public/games/<name>/<name>-client.js` script (loaded after `main.js`, sharing its scope) and a `<div id="<name>-panel">` in `index.html`. Game-specific Socket.IO events should use a `<name>`-prefixed event name (e.g. `heartsPlayCard`) so they can never collide with another game's events, mirroring how Lumo and Hearts already coexist.

## Lumo Feature Highlights

- Host-controlled table start (minimum 2 players)
- Up to 6 players per table
- In-game leave/quit handling and winner resolution
- Wild and Wild Draw Four flow with server-side validation
- Keyboard command support for gameplay actions
- Live screen-reader announcements for turns and game events

## Hearts Feature Highlights

- Standard four-player Hearts: deal, follow-suit, Hearts-breaking (with the only-Hearts-remaining exception), first-trick restrictions, Queen of Spades, shooting the moon
- Full passing cycle (left / right / across / hold) with private, accessible card selection
- Host can start early with fewer than four humans; computer players fill the remaining seats
- Play continues over multiple hands until a hand pushes a player to the configurable "points to end game" (default 100), then the lowest cumulative score wins
- Server-authoritative legal-move enforcement with accessible rejection messages (illegal plays never change game state or advance the turn)

## Spades Feature Highlights

- Fixed four-player partnerships: seats 1 & 3 are one team, seats 2 & 4 are the other, with the dealer seat rotating each hand
- Turn-sequenced bidding (0-13, where a bid of 0 is Nil) starting from the seat left of the dealer, so every player hears prior bids before their own
- Spades are permanent trump, with a spades-breaking rule (and only-spades-remaining exception) analogous to Hearts'
- Partnership scoring: 10 points per trick bid plus 1 point per bag (overtrick) on a made contract, -10 per trick bid on a failed contract, a +100/-100 Nil bonus/penalty, and a -100 bag penalty every time a team's running bag count reaches 10
- Host can start early with fewer than four humans; computer players fill the remaining seats
- Play continues over multiple hands until a hand pushes a team to the configurable "target score" (default 500), then the higher cumulative team score wins

## Accessibility Commitments

- Full keyboard play support
- Screen-reader friendly status and event announcements
- Mouse and touch support without blocking accessible workflows
- Ongoing improvements as each new game is added

## Run Locally

1. Install dependencies:

npm install

2. Start server:

npm start

3. Open in browser:

http://localhost:3000

## Attribution

This project was originally created by Izan Perez Cosano.

Attribution is based on the earliest repository commits, including the first commit on 2019-02-19 authored by Izan Perez Cosano.
