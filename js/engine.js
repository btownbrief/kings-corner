/* KINGS CORNER engine — pure rules, no DOM, no timers, no Math.random.
 *
 * Every function here is a pure function over a plain JSON-serializable
 * state object. The shuffle uses a seeded RNG whose state lives INSIDE the
 * game state, so a game can be JSON.stringify'd, parsed, and resumed — and
 * two states built from the same seed are identical. Online multiplayer
 * later = syncing this exact object. Keep ALL rule logic in this file.
 *
 * Public API:
 *   createInitialState(options) -> state
 *   legalMoves(state)           -> array of move objects for the current player
 *   applyMove(state, move)      -> NEW state (never mutates)
 *   getStatus(state)            -> { status, winner, winners }
 *
 * Cards are 2-char strings: rank + suit, e.g. "8H", "TS" (T = ten).
 * The eight table piles live in state.piles keyed by compass direction:
 * N/E/S/W are the four foundations (flipped at the deal), NE/SE/SW/NW are
 * the four corners (start empty, Kings only).
 *
 * Moves: { type: 'draw' }                       (required first while stock lasts)
 *        { type: 'play', card: '8S', to: 'N' }  (one card from hand onto a pile)
 *        { type: 'move', from: 'N', to: 'E' }   (an ENTIRE pile onto another)
 *        { type: 'endTurn' }
 *
 * Piles are arrays ordered base-first: pile[0] is the card the pile was
 * started with (its highest rank), pile[pile.length - 1] is the exposed
 * card the next play must fit on.
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const FOUNDATIONS = ['N', 'E', 'S', 'W'];
export const CORNERS = ['NE', 'SE', 'SW', 'NW'];
export const PILES = [...FOUNDATIONS, ...CORNERS];

export const rankOf = (card) => card[0];
export const suitOf = (card) => card[1];
export const isRed = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';
export const exposedCard = (pile) => pile[pile.length - 1];
export const baseCard = (pile) => pile[0];

const rankIndex = (card) => RANKS.indexOf(rankOf(card));

/* The one placement rule: exactly one rank lower, opposite color. */
export function fitsOn(card, onto) {
  return rankIndex(card) === rankIndex(onto) - 1 && isRed(card) !== isRed(onto);
}

/* ---------------------------------------------------------------- RNG
 * mulberry32 — tiny, deterministic. The integer state is threaded through
 * and stored on the game state as `rng`. */

function rngNext(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, s };
}

/* Fisher-Yates. Returns { deck, rng } — never touches the input array. */
function shuffle(cards, rngState) {
  const deck = cards.slice();
  let s = rngState;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.s;
    const j = Math.floor(r.value * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return { deck, rng: s };
}

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

/* ---------------------------------------------------------------- setup */

export function createInitialState(options = {}) {
  const numPlayers = options.numPlayers ?? 2;
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new Error('numPlayers must be 2, 3, or 4');
  }
  const seed = (options.seed ?? 1) | 0;

  const { deck, rng } = shuffle(freshDeck(), seed);

  const hands = [];
  for (let p = 0; p < numPlayers; p++) {
    hands.push(deck.slice(p * 7, (p + 1) * 7));
  }
  let i = numPlayers * 7;

  // Flip one card to each foundation. A flipped King simply stays put — a
  // pile based on a King can never move, but plays on it work as usual.
  const piles = { NE: [], SE: [], SW: [], NW: [] };
  for (const f of FOUNDATIONS) piles[f] = [deck[i++]];

  return {
    version: 1,
    seed,
    rng,
    numPlayers,
    hands,
    stock: deck.slice(i),
    piles,
    currentPlayer: 0,
    hasDrawn: false,     // each turn starts with a draw while the stock lasts
    playsThisTurn: 0,    // cards played + piles moved this turn
    passesInARow: 0,     // whole turns with zero plays (only counted stock-out)
    winner: null,
    blocked: false,
    lastAction: null,    // { player, type, card?, to?, from?, count? } — for UI narration
  };
}

/* ---------------------------------------------------------------- rules */

export function legalMoves(state) {
  if (getStatus(state).status !== 'active') return [];

  // Draw first: while the stock has cards, the turn's one draw is mandatory
  // before anything else. Once the stock is out, play continues without it.
  if (!state.hasDrawn && state.stock.length > 0) {
    return [{ type: 'draw' }];
  }

  const moves = [];
  const hand = state.hands[state.currentPlayer];

  for (const card of hand) {
    for (const id of PILES) {
      const pile = state.piles[id];
      if (pile.length > 0) {
        if (fitsOn(card, exposedCard(pile))) moves.push({ type: 'play', card, to: id });
      } else if (FOUNDATIONS.includes(id)) {
        moves.push({ type: 'play', card, to: id }); // emptied foundation: any card
      } else if (rankOf(card) === 'K') {
        moves.push({ type: 'play', card, to: id }); // corners open with Kings only
      }
    }
  }

  // Whole-pile moves: the moved pile's BASE card must fit the target's
  // exposed card. (A pile based on a King can never move — nothing outranks
  // a King — so corner piles always stay put.)
  for (const from of PILES) {
    const pile = state.piles[from];
    if (pile.length === 0) continue;
    for (const to of PILES) {
      if (to === from || state.piles[to].length === 0) continue;
      if (fitsOn(baseCard(pile), exposedCard(state.piles[to]))) {
        moves.push({ type: 'move', from, to });
      }
    }
  }

  moves.push({ type: 'endTurn' });
  return moves;
}

/* ---------------------------------------------------------------- apply */

function sameMove(a, b) {
  return a.type === b.type && a.card === b.card && a.from === b.from && a.to === b.to;
}

export function applyMove(state, move) {
  const legal = legalMoves(state);
  if (!legal.some((m) => sameMove(m, move))) {
    throw new Error('Illegal move: ' + JSON.stringify(move));
  }

  if (move.type === 'draw') return applyDraw(state);
  if (move.type === 'play') return applyPlay(state, move);
  if (move.type === 'move') return applyPileMove(state, move);
  return applyEndTurn(state);
}

function applyDraw(state) {
  const player = state.currentPlayer;
  const drawn = state.stock[state.stock.length - 1];
  return {
    ...state,
    hands: state.hands.map((h, p) => (p === player ? h.concat([drawn]) : h)),
    stock: state.stock.slice(0, -1),
    hasDrawn: true,
    lastAction: { player, type: 'draw' },
  };
}

function applyPlay(state, move) {
  const player = state.currentPlayer;
  const hand = state.hands[player];
  const idx = hand.indexOf(move.card);
  const newHand = hand.slice(0, idx).concat(hand.slice(idx + 1));
  return {
    ...state,
    hands: state.hands.map((h, p) => (p === player ? newHand : h)),
    piles: { ...state.piles, [move.to]: state.piles[move.to].concat([move.card]) },
    playsThisTurn: state.playsThisTurn + 1,
    // shedding your last card wins on the spot — no need to end the turn
    winner: newHand.length === 0 ? player : state.winner,
    lastAction: { player, type: 'play', card: move.card, to: move.to },
  };
}

function applyPileMove(state, move) {
  const player = state.currentPlayer;
  const moved = state.piles[move.from];
  return {
    ...state,
    piles: {
      ...state.piles,
      [move.to]: state.piles[move.to].concat(moved),
      [move.from]: [],
    },
    playsThisTurn: state.playsThisTurn + 1,
    lastAction: { player, type: 'move', from: move.from, to: move.to, count: moved.length },
  };
}

function applyEndTurn(state) {
  const player = state.currentPlayer;
  const passed = state.playsThisTurn === 0;
  const passesInARow = passed ? state.passesInARow + 1 : 0;
  return {
    ...state,
    currentPlayer: (player + 1) % state.numPlayers,
    hasDrawn: false,
    playsThisTurn: 0,
    passesInARow,
    // Stock gone and a full lap of turns with nobody playing a thing: the
    // table is jammed. Fewest cards wins (see getStatus) so it can't hang.
    blocked: state.stock.length === 0 && passesInARow >= state.numPlayers,
    lastAction: { player, type: 'endTurn', passed },
  };
}

/* ---------------------------------------------------------------- status */

export function getStatus(state) {
  if (state.winner !== null) {
    return { status: 'won', winner: state.winner, winners: [state.winner] };
  }
  if (state.blocked) {
    const min = Math.min(...state.hands.map((h) => h.length));
    const winners = [];
    state.hands.forEach((h, p) => { if (h.length === min) winners.push(p); });
    return { status: 'blocked', winner: winners.length === 1 ? winners[0] : null, winners };
  }
  return { status: 'active', winner: null, winners: [] };
}
