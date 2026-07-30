// Online-rooms wiring test: drives the real vendored client (js/rooms.js)
// against the local shim (scripts/rooms-shim.mjs) as two simulated phones,
// then plays through the real Kings Corner engine. No network or Supabase.
//
//   node scripts/test-rooms.mjs

import { createRooms } from './rooms-shim.mjs';
import { createInitialState, legalMoves, applyMove, getStatus } from '../js/engine.js';

const GAME = 'kings-corner';

/* ------------------------------------------------- two-phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (key) => (stores.get(current).has(key) ? stores.get(current).get(key) : null),
  setItem: (key, value) => stores.get(current).set(key, String(value)),
  removeItem: (key) => stores.get(current).delete(key),
};
function device(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  current = id;
}
device('A');
device('B');

let passed = 0;
function t(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (err) {
    t(err?.code === code, `${label} (got ${err?.code})`);
  }
}

// Route the real client into the real shim RPCs without opening a local
// socket. This keeps the test runnable in sandboxes that forbid listen().
const shim = createRooms();
let backendReady = true;
globalThis.BTOWN_ROOMS_URL = 'http://rooms.test';
globalThis.fetch = async (url, options = {}) => {
  if (!backendReady) return new Response('{}', { status: 404 });
  const fn = String(url).match(/\/rest\/v1\/rpc\/(\w+)$/)?.[1];
  if (!fn || !shim.rpcs[fn]) return new Response('{}', { status: 404 });
  try {
    const args = JSON.parse(options.body || '{}');
    return new Response(JSON.stringify(shim.rpcs[fn](args) ?? {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: err.message }), {
      status: err.rpc ? 400 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
const { OnlineMatch, savedSession } = await import('../js/rooms.js');

/* ------------------------------------------------------------ the tests */

device('A');
const host = await OnlineMatch.create({
  game: GAME,
  name: 'Neighbor A',
  state: createInitialState({ numPlayers: 2, seed: 501 }),
  seats: 2,
});
t(/^[A-Z2-9]{4}$/.test(host.code) && host.seat === 0 && host.status === 'waiting',
  'host creates room in engine seat 0');
t(savedSession(GAME)?.roomId === host.roomId, 'host session saved');

device('B');
await expectCode(OnlineMatch.join({ game: GAME, code: 'ZZZZ', name: 'X' }),
  'not_found', 'bad code rejected');
await expectCode(OnlineMatch.join({ game: 'crazy-eights', code: host.code, name: 'X' }),
  'wrong_game', 'wrong game rejected');
const guest = await OnlineMatch.join({
  game: GAME,
  code: ` ${host.code.toLowerCase()} `,
  name: 'Neighbor B',
});
t(guest.seat === 1 && guest.status === 'playing',
  'guest joins engine seat 1 and game starts');
t(guest.opponents().length === 1 && guest.opponents()[0].name === 'Neighbor A',
  'guest sees host name');

device('A');
await host._fetch();
t(host.status === 'playing' && host.opponents()[0].name === 'Neighbor B',
  'host poll sees game start and guest name');

// Referee: push, sync, and reject a stale version.
const first = applyMove(host.state, legalMoves(host.state)[0]);
await host.push(first);
t(host.version === 1, 'host pushes first engine move, version 1');

device('B');
await guest._fetch();
t(guest.state.currentPlayer === 0 && guest.state.hasDrawn,
  'guest poll receives host draw without changing seats');
const stale = applyMove(guest.state, legalMoves(guest.state)[0]);

device('A');
const second = applyMove(host.state, legalMoves(host.state)[0]);
await host.push(second);
t(host.version === 2, 'host pushes another legal move, version 2');

device('B');
await expectCode(guest.push(stale), 'version_conflict', 'stale push rejected');
t(guest.version === 2 && JSON.stringify(guest.state) === JSON.stringify(host.state),
  'conflict refetches the shared truth');

// Full game: each engine player uses its matching rooms seat. Favor hand
// plays, then use a seeded random choice among the remaining legal moves.
const phones = [
  { match: host, device: 'A' },
  { match: guest, device: 'B' },
];
let randomState = 0x6d2b79f5;
function randomIndex(length) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) | 0;
  return (randomState >>> 0) % length;
}
function randomMove(state) {
  const moves = legalMoves(state);
  const plays = moves.filter((move) => move.type === 'play');
  if (plays.length) return plays[randomIndex(plays.length)];
  const draws = moves.filter((move) => move.type === 'draw');
  if (draws.length) return draws[0];
  const pileMoves = moves.filter((move) => move.type === 'move');
  if (pileMoves.length && randomIndex(4) === 0) {
    return pileMoves[randomIndex(pileMoves.length)];
  }
  const endings = moves.filter((move) => move.type === 'endTurn');
  return endings[randomIndex(endings.length)];
}

let movesPlayed = 0;
while (getStatus(host.state).status === 'active' && movesPlayed < 400) {
  const seat = host.state.currentPlayer;
  const mover = phones[seat];
  device(mover.device);
  await mover.match._fetch();
  const next = applyMove(mover.match.state, randomMove(mover.match.state));
  await mover.match.push(next, { over: getStatus(next).status !== 'active' });

  for (const phone of phones) {
    device(phone.device);
    await phone.match._fetch();
  }
  if (JSON.stringify(host.state) !== JSON.stringify(guest.state)) {
    console.error(`FAIL: phones diverged after engine move ${movesPlayed + 1}`);
    process.exit(1);
  }
  movesPlayed++;
}

const finalStatus = getStatus(host.state);
t(movesPlayed > 0, `phones stay synced through ${movesPlayed} engine moves`);
t(finalStatus.status !== 'active' || movesPlayed === 400,
  finalStatus.status === 'active' ? '400-move cap reached cleanly' : `full game ends ${finalStatus.status}`);
t(JSON.stringify(host.state) === JSON.stringify(guest.state),
  'both phones finish with JSON-identical states');
t(host.status === guest.status, 'both phones agree on room status');

if (finalStatus.status !== 'active') {
  device('B');
  const rematch = createInitialState({ numPlayers: 2, seed: 90210 });
  await guest.push(rematch);
  t(guest.status === 'playing' && guest.state.currentPlayer === 0,
    'either phone can deal a rematch and host seat opens');
}

device('A');
const resumed = await OnlineMatch.resume({ game: GAME });
t(resumed.roomId === host.roomId && resumed.seat === 0,
  'resume reattaches host to the same seat');

await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await guest._fetch();
t(guest.status === 'over' && guest.opponents()[0].left,
  'guest sees that host left');

device('A');
const secondHost = await OnlineMatch.create({
  game: GAME,
  name: 'A',
  state: createInitialState({ numPlayers: 2, seed: 12 }),
});
device('B');
await OnlineMatch.join({ game: GAME, code: secondHost.code, name: 'B' });
device('C');
await expectCode(
  OnlineMatch.join({ game: GAME, code: secondHost.code, name: 'C' }),
  'room_started',
  'third phone is turned away',
);

// Backend not installed: 404 RPCs become a clean not_ready error.
backendReady = false;
const fresh = await import('../js/rooms.js?not-ready');
await expectCode(
  fresh.OnlineMatch.create({ game: GAME, name: 'A', state: {} }),
  'not_ready',
  'missing backend reads as not_ready',
);

console.log(`\nALL ROOMS TESTS PASSED (${passed} checks, ${movesPlayed} engine moves)`);
process.exit(0);
