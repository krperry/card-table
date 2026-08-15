// Assembles the game-module registry consumed by server.js's generic
// dispatchers. Each playable game is a factory function (see games/lumo,
// games/hearts, games/spades, games/cribbage) that receives a small `deps`
// object of shared table/networking primitives and returns the game-module
// interface - there are no remaining static/non-playable placeholder entries.

const createLumoGame = require('./lumo');
const createHeartsGame = require('./hearts');
const createSpadesGame = require('./spades');
const createCribbageGame = require('./cribbage');

module.exports = function buildGameRegistry(deps) {
  const lumo = createLumoGame(deps);
  const hearts = createHeartsGame(deps);
  const spades = createSpadesGame(deps);
  const cribbage = createCribbageGame(deps);

  const modules = {
    uno: lumo,
    hearts: hearts,
    spades: spades,
    cribbage: cribbage
  };

  const definitions = {
    uno: { type: 'uno', name: lumo.name, playable: lumo.playable !== false, minPlayers: lumo.minPlayers, maxPlayers: lumo.maxPlayers },
    hearts: { type: 'hearts', name: hearts.name, playable: hearts.playable !== false, minPlayers: hearts.minPlayers, maxPlayers: hearts.maxPlayers },
    spades: { type: 'spades', name: spades.name, playable: spades.playable !== false, minPlayers: spades.minPlayers, maxPlayers: spades.maxPlayers },
    cribbage: { type: 'cribbage', name: cribbage.name, playable: cribbage.playable !== false, minPlayers: cribbage.minPlayers, maxPlayers: cribbage.maxPlayers }
  };

  return { modules: modules, definitions: definitions };
};
