// Assembles the game-module registry consumed by server.js's generic
// dispatchers. Each playable game is a factory function (see games/lumo,
// games/hearts) that receives a small `deps` object of shared table/
// networking primitives and returns the game-module interface. Non-playable
// placeholders (spades, cribbage) are static entries with no module - the
// generic code in server.js already treats `GAME_MODULES[type]` as optional.

const createLumoGame = require('./lumo');
const createHeartsGame = require('./hearts');
const createSpadesGame = require('./spades');

module.exports = function buildGameRegistry(deps) {
  const lumo = createLumoGame(deps);
  const hearts = createHeartsGame(deps);
  const spades = createSpadesGame(deps);

  const modules = {
    uno: lumo,
    hearts: hearts,
    spades: spades
  };

  const definitions = {
    uno: { type: 'uno', name: lumo.name, playable: lumo.playable !== false, minPlayers: lumo.minPlayers, maxPlayers: lumo.maxPlayers },
    hearts: { type: 'hearts', name: hearts.name, playable: hearts.playable !== false, minPlayers: hearts.minPlayers, maxPlayers: hearts.maxPlayers },
    spades: { type: 'spades', name: spades.name, playable: spades.playable !== false, minPlayers: spades.minPlayers, maxPlayers: spades.maxPlayers },
    cribbage: { type: 'cribbage', name: 'Cribbage', playable: false, minPlayers: 2, maxPlayers: 2 }
  };

  return { modules: modules, definitions: definitions };
};
