/* Engine test — plain Node, no framework. Run: node scripts/test-engine.mjs
 * Exercises the pure engine only; nothing here touches the DOM. */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, exposedCard, baseCard, fitsOn,
  FOUNDATIONS, CORNERS, PILES,
} from '../js/engine.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

/* Helper: build a hand-crafted mid-game state (JSON-serializable, like the
 * real thing) so we can test exact rules without hunting for a seed.
 * Defaults: stock already drawn from (hasDrawn true) so plays are open. */
function fixture(overrides = {}) {
  const base = createInitialState({ numPlayers: 2, seed: 42 });
  return { ...base, hasDrawn: true, ...overrides };
}

const emptyPiles = () => ({ N: [], E: [], S: [], W: [], NE: [], SE: [], SW: [], NW: [] });

function allCards(state) {
  return [...state.stock, ...state.hands.flat(), ...PILES.flatMap((id) => state.piles[id])];
}

/* ---------------------------------------------------------- determinism */
{
  const a = createInitialState({ numPlayers: 2, seed: 12345 });
  const b = createInitialState({ numPlayers: 2, seed: 12345 });
  const c = createInitialState({ numPlayers: 2, seed: 54321 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical deal');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different deal');
  assert(a.hands.length === 2 && a.hands.every((h) => h.length === 7), '2 players get 7 cards each');
  assert(FOUNDATIONS.every((f) => a.piles[f].length === 1), 'one card flipped to each foundation');
  assert(CORNERS.every((k) => a.piles[k].length === 0), 'all four corners start empty');
  const cards = allCards(a);
  assert(cards.length === 52 && new Set(cards).size === 52, 'full 52-card deck accounted for');
}

/* --------------------------------------- 3- and 4-player table behavior */
for (const numPlayers of [3, 4]) {
  let s = createInitialState({ numPlayers, seed: 700 + numPlayers });
  assert(s.hands.length === numPlayers && s.hands.every((hand) => hand.length === 7),
    `${numPlayers} players get 7 cards each`);

  for (let player = 0; player < numPlayers; player++) {
    s = applyMove(s, { type: 'draw' });
    s = applyMove(s, { type: 'endTurn' });
    assert(s.currentPlayer === (player + 1) % numPlayers,
      `${numPlayers}-player turns rotate from Player ${player + 1} to Player ${(player + 1) % numPlayers + 1}`);
  }

  const winningSeat = numPlayers - 1;
  const winState = fixture({
    numPlayers,
    hands: Array.from({ length: numPlayers }, (_, seat) =>
      seat === winningSeat ? ['8S'] : ['2C', '3C']),
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: [],
    currentPlayer: winningSeat,
  });
  const won = applyMove(winState, { type: 'play', card: '8S', to: 'N' });
  assert(getStatus(won).status === 'won' && getStatus(won).winner === winningSeat,
    `${numPlayers}-player game detects Player ${winningSeat + 1}'s win immediately`);
}

/* ---------------------------------- descending alternating-color legality */
{
  const s = fixture({
    hands: [['8S', '8H', 'TC', '4C', 'KD'], ['2C', '3C', '5C', '6C']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TC'].slice(0, 0).concat(['TS']), S: ['9D'], W: ['QC'] },
    stock: ['2D', '3D'],
    currentPlayer: 0,
  });
  const toN = legalMoves(s).filter((m) => m.type === 'play' && m.to === 'N').map((m) => m.card);
  assert(toN.includes('8S'), 'one rank down + opposite color is legal (8S on 9H)');
  assert(!toN.includes('8H'), 'same color is not legal (8H on 9H)');
  assert(!toN.includes('TC'), 'one rank UP is not legal (TC on 9H)');
  assert(!toN.includes('4C'), 'wrong rank is not legal (4C on 9H)');
  assert(fitsOn('9H', 'TS') && !fitsOn('9H', 'TD') && !fitsOn('JH', 'TS'),
    'fitsOn: exactly one lower and opposite color');

  const after = applyMove(s, { type: 'play', card: '8S', to: 'N' });
  assert(exposedCard(after.piles.N) === '8S', 'played card becomes the exposed card');
  assert(after.hands[0].length === 4, 'played card leaves the hand');
  assert(s.hands[0].length === 5 && s.piles.N.length === 1, 'applyMove did not mutate the old state');
  assert(after.currentPlayer === 0, 'playing a card keeps the turn (play as many as you can)');
}

/* --------------------------------------------- only Kings open corners */
{
  const s = fixture({
    hands: [['KD', 'QS', '4C'], ['2C', '3C']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: [],
    currentPlayer: 0,
  });
  const moves = legalMoves(s);
  const cornerPlays = moves.filter((m) => m.type === 'play' && CORNERS.includes(m.to));
  assert(cornerPlays.length === 4 && cornerPlays.every((m) => m.card === 'KD'),
    'only the King may open a corner (all 4 corners offered)');
  assert(!moves.some((m) => m.card === 'QS' && CORNERS.includes(m.to)),
    'a Queen cannot open a corner');

  const after = applyMove(s, { type: 'play', card: 'KD', to: 'NW' });
  assert(baseCard(after.piles.NW) === 'KD', 'King lands in the corner');
  const qOnK = legalMoves(after).filter((m) => m.type === 'play' && m.to === 'NW').map((m) => m.card);
  assert(qOnK.includes('QS'), 'QS plays on the cornered KD (down one, opposite color)');
}

/* ----------------------------------------------------- whole-pile moves */
{
  const s = fixture({
    hands: [['5H'], ['2C', '3C']],
    piles: { ...emptyPiles(), N: ['9H', '8S'], E: ['TS'], S: ['9D'], W: ['QC'], NE: ['KD', 'QS', 'JH'] },
    stock: [],
    currentPlayer: 0,
  });
  const moves = legalMoves(s);
  assert(moves.some((m) => m.type === 'move' && m.from === 'N' && m.to === 'E'),
    'pile moves when its BASE fits the target (9H base onto TS)');
  assert(!moves.some((m) => m.type === 'move' && m.from === 'N' && m.to === 'S'),
    'pile cannot move when the base is the same color as the target (9H onto 9D pile? colors)');
  assert(!moves.some((m) => m.type === 'move' && m.from === 'NE'),
    'a corner pile (King base) can never move');
  assert(!moves.some((m) => m.type === 'move' && m.from === 'S' && m.to === 'N'),
    'exposed card is the target, not the base (9D does not go on 8S)');

  const after = applyMove(s, { type: 'move', from: 'N', to: 'E' });
  assert(JSON.stringify(after.piles.E) === JSON.stringify(['TS', '9H', '8S']),
    'the ENTIRE pile moves, in order');
  assert(after.piles.N.length === 0, 'the source foundation is left empty');
  assert(after.lastAction.count === 2, 'lastAction reports how many cards slid');

  // pile-on-pile again: the merged pile's base is still TS, which fits the
  // corner's exposed JH — so the whole 3-card pile can slide onto the corner
  assert(legalMoves(after).some((m) => m.type === 'move' && m.from === 'E' && m.to === 'NE'),
    'merged pile keeps the original base (TS pile slides onto the JH corner)');
  const onCorner = applyMove(after, { type: 'move', from: 'E', to: 'NE' });
  assert(JSON.stringify(onCorner.piles.NE) === JSON.stringify(['KD', 'QS', 'JH', 'TS', '9H', '8S']),
    'corner pile builds K down to 8, alternating colors');
}

/* -------------------------------- dealt King moves to an empty corner */
{
  const s = fixture({
    hands: [['5H', '7C'], ['2C', '3C']],
    piles: {
      ...emptyPiles(),
      N: ['KD', 'QS'], E: ['TS'], S: ['9D'], W: ['QC'],
      NW: ['KC', 'QH'],
    },
    stock: [],
    currentPlayer: 0,
  });
  const moves = legalMoves(s);
  assert(moves.some((m) => m.type === 'move' && m.from === 'N' && m.to === 'NE'),
    'a King-based foundation pile may move to an empty corner');
  assert(!moves.some((m) => m.type === 'move' && m.from === 'NW' && m.to === 'NE'),
    'a corner pile cannot move to another empty corner');

  const relocated = applyMove(s, { type: 'move', from: 'N', to: 'NE' });
  assert(relocated.piles.N.length === 0 &&
    JSON.stringify(relocated.piles.NE) === JSON.stringify(['KD', 'QS']),
    'the dealt-King pile relocates intact and empties its foundation');
  const refilled = applyMove(relocated, { type: 'play', card: '5H', to: 'N' });
  assert(JSON.stringify(refilled.piles.N) === JSON.stringify(['5H']),
    'the foundation emptied by a dealt King accepts any hand card');

  const { chooseMove } = await import('../js/bot.js');
  const botMove = chooseMove(s);
  assert(botMove.type === 'move' && botMove.from === 'N' &&
    CORNERS.includes(botMove.to) && s.piles[botMove.to].length === 0,
    'the bot prefers moving a King-based foundation pile into an empty corner');
}

/* --------------------------------------- refilling an emptied foundation */
{
  const s = fixture({
    hands: [['5H', 'KC'], ['2C', '3C']],
    piles: { ...emptyPiles(), N: [], E: ['TS', '9H', '8S'], S: ['9D'], W: ['QC'] },
    stock: [],
    currentPlayer: 0,
  });
  const toN = legalMoves(s).filter((m) => m.type === 'play' && m.to === 'N').map((m) => m.card);
  assert(toN.includes('5H') && toN.includes('KC'), 'an emptied foundation takes ANY card from hand');
  const after = applyMove(s, { type: 'play', card: '5H', to: 'N' });
  assert(JSON.stringify(after.piles.N) === JSON.stringify(['5H']), 'refill starts a fresh pile');
}

/* ------------------------------------------------ draw-then-play order */
{
  let s = fixture({
    hands: [['8S'], ['2C']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: ['4D', '7C'],
    currentPlayer: 0,
    hasDrawn: false,
  });
  const first = legalMoves(s);
  assert(first.length === 1 && first[0].type === 'draw', 'the turn MUST start with a draw');
  s = applyMove(s, { type: 'draw' });
  assert(s.hands[0].length === 2 && s.stock.length === 1, 'draw takes one card off the stock');
  const then = legalMoves(s);
  assert(!then.some((m) => m.type === 'draw'), 'only one draw per turn');
  assert(then.some((m) => m.type === 'play' && m.card === '8S' && m.to === 'N'), 'plays open up after the draw');
  assert(then.some((m) => m.type === 'endTurn'), 'ending the turn is always on the menu after the draw');
  s = applyMove(s, { type: 'endTurn' });
  assert(s.currentPlayer === 1 && s.hasDrawn === false, 'endTurn passes play and re-arms the draw');

  // stock empty: play continues with no draw at all
  const dry = fixture({
    hands: [['8S'], ['2C']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: [],
    currentPlayer: 0,
    hasDrawn: false,
  });
  assert(!legalMoves(dry).some((m) => m.type === 'draw') &&
    legalMoves(dry).some((m) => m.type === 'play'),
    'empty stock: no draw required, straight to playing');

  let lastDraw = fixture({
    hands: [['4C'], ['2H']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: ['7C'],
    currentPlayer: 0,
    hasDrawn: false,
    passesInARow: 1,
  });
  lastDraw = applyMove(lastDraw, { type: 'draw' });
  assert(lastDraw.stock.length === 0 && lastDraw.passesInARow === 0,
    'drawing the last stock card resets passes accrued while stock remained');
  lastDraw = applyMove(lastDraw, { type: 'endTurn' });
  assert(getStatus(lastDraw).status === 'active' && lastDraw.passesInARow === 1,
    'gridlock needs a fresh full lap after the stock becomes empty');
  lastDraw = applyMove(lastDraw, { type: 'endTurn' });
  assert(getStatus(lastDraw).status === 'blocked',
    'gridlock starts after that fresh full lap is complete');
}

/* --------------------------------------------------------- win detection */
{
  const s = fixture({
    hands: [['8S'], ['2C', '3C']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: ['4D'],
    currentPlayer: 0,
  });
  const after = applyMove(s, { type: 'play', card: '8S', to: 'N' });
  const st = getStatus(after);
  assert(st.status === 'won' && st.winner === 0, 'shedding the last card wins IMMEDIATELY, mid-turn');
  assert(legalMoves(after).length === 0, 'no legal moves once the game is over');
}

/* ------------------------------------------------- blocked table ends it */
{
  let s = fixture({
    hands: [['4C', '5C'], ['2H']],
    piles: { ...emptyPiles(), N: ['9H'], E: ['TS'], S: ['9D'], W: ['QC'] },
    stock: [],
    currentPlayer: 0,
    hasDrawn: false,
  });
  s = applyMove(s, { type: 'endTurn' }); // P0: nothing playable, passes
  s = applyMove(s, { type: 'endTurn' }); // P1: same
  const st = getStatus(s);
  assert(st.status === 'blocked' && st.winner === 1,
    'stock out + a full lap of no plays = blocked, fewest cards wins');
}

/* -------------------------------------------- serialization round-trip */
{
  let s = createInitialState({ numPlayers: 2, seed: 999 });
  const { chooseMove } = await import('../js/bot.js');
  for (let i = 0; i < 30 && getStatus(s).status === 'active'; i++) {
    s = JSON.parse(JSON.stringify(s));
    s = applyMove(s, chooseMove(s));
  }
  const thawed = JSON.parse(JSON.stringify(s));
  assert(JSON.stringify(legalMoves(thawed)) === JSON.stringify(legalMoves(s)),
    'game survives stringify/parse mid-run with identical legal moves');
}

/* ------------------------------------- full-game soak: engine + bot */
{
  const { chooseMove } = await import('../js/bot.js');
  let finished = 0;
  let broke = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const numPlayers of [2, 3, 4]) {
      let s = createInitialState({ numPlayers, seed });
      let guard = 0;
      while (getStatus(s).status === 'active' && guard++ < 5000) {
        s = applyMove(s, chooseMove(s));
      }
      if (getStatus(s).status !== 'active') finished++;
      const cards = allCards(s);
      if (cards.length !== 52 || new Set(cards).size !== 52) {
        broke++;
        console.error(`FAIL  card conservation broke (seed ${seed}, ${numPlayers}p)`);
      }
    }
  }
  assert(broke === 0, '52 cards conserved through every soak game');
  assert(finished === 600, `600/600 bot-vs-bot games finish (got ${finished})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
