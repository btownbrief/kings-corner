/* KINGS CORNER — UI only. All rules live in engine.js; the Mayor lives in
 * bot.js. This file renders state, handles taps, paces the bot with
 * timers, and saves/restores the game (the whole game state is one
 * JSON-serializable object, so localStorage resume is a stringify away). */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, suitOf, isRed, exposedCard,
  PILES, CORNERS,
} from './engine.js';
import { chooseMove } from './bot.js';

const SAVE_KEY = 'kings-corner-save-v1';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is the Mayor

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 }; // alternate colors in the fan
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';
const MAX_SHOWN = 4;   // cards visibly cascaded per pile
const CASCADE = 13;    // px between cascaded cards

/* Where things are, Burlington-wise. */
const PILE_NAME = {
  N: 'Pearl St', E: 'Cherry St', S: 'Main St', W: 'Bank St',
  NE: 'the College & Church corner', SE: 'the Main & Church corner',
  SW: 'the Main & St. Paul corner', NW: 'the College & St. Paul corner',
};

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };
const cellEls = {};
document.querySelectorAll('#park .cell[data-pile]').forEach((el) => { cellEls[el.dataset.pile] = el; });

let G = null;             // { mode: 'bot' | 'pass', state }
let sel = null;           // { kind: 'card', card } | { kind: 'pile', id } | null
let handRevealed = true;  // pass & play: false until the handoff button is tapped
let botTimer = null;

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const suitSpan = (card) =>
  `<span class="${isRed(card) ? 'red' : ''}">${SUIT_CHAR[suitOf(card)]}</span>`;
const cardHtml = (card) => `${rankChar(card)}${suitSpan(card)}`;

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'The Mayor' : 'You';
  return 'Player ' + (p + 1);
}

function humanTurn() {
  return G && getStatus(G.state).status === 'active' &&
    !(G.mode === 'bot' && G.state.currentPlayer === BOT);
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G && getStatus(G.state).status === 'active') {
      localStorage.setItem(SAVE_KEY, JSON.stringify(G));
    } else {
      localStorage.removeItem(SAVE_KEY);
    }
  } catch (e) { /* private mode etc. — play on without saving */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.state?.version === 1 && getStatus(saved.state).status === 'active') return saved;
  } catch (e) { /* corrupted save — ignore it */ }
  return null;
}

/* ---------------------------------------------------------------- cards */

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card ' + (isRed(card) ? 'red' : 'black');
  el.dataset.card = card;
  const r = rankChar(card);
  const s = SUIT_CHAR[suitOf(card)];
  const pip = rankOf(card) === 'K' ? '♚' : s;
  el.innerHTML =
    `<div class="corner">${r}<br>${s}</div>` +
    `<div class="pip">${pip}</div>` +
    `<div class="corner flip">${r}<br>${s}</div>`;
  return el;
}

function sortedHand(hand) {
  return hand.slice().sort((a, b) =>
    (SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)]) ||
    (RANK_SORT.indexOf(rankOf(a)) - RANK_SORT.indexOf(rankOf(b))));
}

/* Legal destinations for the current selection, from the engine's move list. */
function targetsFor(moves, selection) {
  const t = new Set();
  if (!selection) return t;
  for (const m of moves) {
    if (selection.kind === 'card' && m.type === 'play' && m.card === selection.card) t.add(m.to);
    if (selection.kind === 'pile' && m.type === 'move' && m.from === selection.id) t.add(m.to);
  }
  return t;
}

/* ---------------------------------------------------------------- render */

function render(fx = {}) {
  const state = G.state;
  const moves = legalMoves(state);
  const myTurn = humanTurn();
  const mustDraw = moves.length === 1 && moves[0].type === 'draw';
  const playable = new Set(moves.filter((m) => m.type === 'play').map((m) => m.card));
  const movable = new Set(moves.filter((m) => m.type === 'move').map((m) => m.from));
  const targets = myTurn ? targetsFor(moves, sel) : new Set();
  const onlyEndTurn = moves.length === 1 && moves[0].type === 'endTurn';

  // opponents bar
  const opps = $('opponents');
  opps.innerHTML = '';
  for (let p = 0; p < state.numPlayers; p++) {
    if (G.mode === 'bot' && p !== BOT) continue; // your own hand is on the table
    const chip = document.createElement('div');
    chip.className = 'opp' + (state.currentPlayer === p ? ' active' : '');
    chip.innerHTML =
      `<span>${G.mode === 'bot' ? '🎩 The Mayor' : 'P' + (p + 1)}</span>` +
      `<span class="opp-count">${state.hands[p].length}</span>`;
    opps.appendChild(chip);
  }

  // stock
  const stock = $('stock');
  stock.classList.toggle('drawable', myTurn && mustDraw);
  stock.classList.toggle('empty', state.stock.length === 0);
  $('stockCount').textContent = state.stock.length === 0 ? 'STOCK OUT' : state.stock.length + ' LEFT';
  if (fx.stockBump) {
    stock.classList.remove('bump'); void stock.offsetWidth; stock.classList.add('bump');
  }

  // the eight piles
  for (const id of PILES) {
    const cell = cellEls[id];
    const pc = cell.querySelector('.pilecards');
    const pile = state.piles[id];
    pc.innerHTML = '';
    cell.classList.toggle('empty', pile.length === 0);
    cell.classList.toggle('target', targets.has(id));
    cell.classList.toggle('selected', sel?.kind === 'pile' && sel.id === id);
    cell.classList.toggle('movable', myTurn && !sel && movable.has(id));
    const shown = pile.slice(-MAX_SHOWN);
    shown.forEach((card, i) => {
      const el = cardEl(card);
      el.style.top = (i * CASCADE) + 'px';
      if (i < shown.length - 1) el.classList.add('under');
      pc.appendChild(el);
    });
    if (pile.length > 1) {
      const badge = document.createElement('div');
      badge.className = 'pile-count';
      badge.textContent = pile.length;
      pc.appendChild(badge);
    }
    if (fx.playedTo === id && shown.length) {
      pc.querySelector('.card:last-of-type')?.classList.add('slap');
    }
  }
  if (fx.slide) animateSlide(fx.slide, state);

  // end-turn button
  const endBtn = $('endTurnBtn');
  endBtn.classList.toggle('hidden', !(myTurn && !mustDraw));
  endBtn.classList.toggle('urge', myTurn && onlyEndTurn);

  // hand — in bot mode always the human's; in pass mode the current player's
  const handOwner = G.mode === 'bot' ? 0 : state.currentPlayer;
  $('handLabel').textContent = G.mode === 'bot'
    ? 'your hand'
    : playerName(handOwner) + "'s hand";
  const handEl = $('hand');
  handEl.innerHTML = '';
  if (handRevealed) {
    const cards = sortedHand(state.hands[handOwner]);
    const lastDrawn = (state.lastAction?.type === 'draw' && state.lastAction.player === handOwner)
      ? state.hands[handOwner][state.hands[handOwner].length - 1] : null;
    // fan the hand: small rotation per card around a low pivot, with the
    // ends of the arc dipping slightly — like cards held in a hand
    const n = cards.length;
    const mid = (n - 1) / 2;
    const spread = Math.min(4.5, 36 / Math.max(n, 1)); // degrees between cards
    cards.forEach((card, i) => {
      const el = cardEl(card);
      el.style.setProperty('--rot', ((i - mid) * spread).toFixed(2) + 'deg');
      el.style.setProperty('--arc', Math.min(18, Math.pow(Math.abs(i - mid), 1.7) * 1.5).toFixed(1) + 'px');
      if (myTurn && playable.has(card)) el.classList.add('playable');
      if (sel?.kind === 'card' && sel.card === card) el.classList.add('selected');
      if (fx.dealAll) { el.classList.add('deal-in'); el.style.animationDelay = (i * 45) + 'ms'; }
      else if (card === lastDrawn && fx.drew) el.classList.add('deal-in');
      el.addEventListener('click', (e) => { e.stopPropagation(); onCardTap(card, el); });
      handEl.appendChild(el);
    });
  }

  renderMessage(moves, myTurn, mustDraw, onlyEndTurn);
}

/* FLIP: the moved cards were rendered in their new pile; start them where
 * the old pile sat and let them slide home. */
function animateSlide(slide, state) {
  const toPc = cellEls[slide.to].querySelector('.pilecards');
  const toRect = toPc.getBoundingClientRect();
  const dx = slide.fromRect.left - toRect.left;
  const dy = slide.fromRect.top - toRect.top;
  const els = [...toPc.querySelectorAll('.card')];
  const nMoved = Math.min(slide.count, els.length);
  const movers = els.slice(els.length - nMoved);
  movers.forEach((el) => {
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.zIndex = 5;
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    movers.forEach((el) => {
      el.style.transition = 'transform 0.34s cubic-bezier(0.2, 1.1, 0.4, 1)';
      el.style.transform = '';
    });
    setTimeout(() => movers.forEach((el) => {
      el.style.transition = ''; el.style.zIndex = '';
    }), 380);
  }));
}

function renderMessage(moves, myTurn, mustDraw, onlyEndTurn) {
  const state = G.state;
  const last = state.lastAction;
  const lines = [];

  if (last && !(myTurn && mustDraw)) {
    const who = playerName(last.player);
    if (last.type === 'play') {
      lines.push(`${who} played ${cardHtml(last.card)} on ${PILE_NAME[last.to]}.`);
    } else if (last.type === 'move') {
      lines.push(`${who} slid ${last.count} card${last.count === 1 ? '' : 's'} from ${PILE_NAME[last.from]} onto ${PILE_NAME[last.to]}.`);
    } else if (last.type === 'endTurn' && last.passed) {
      lines.push(`${who} had nothing — it happens on the nicest streets.`);
    }
  }

  if (getStatus(state).status !== 'active') { $('msg').innerHTML = lines.join(' '); return; }

  if (myTurn) {
    if (mustDraw) {
      lines.push('Tap the stack to draw — then play everything you can.');
    } else if (sel?.kind === 'card') {
      lines.push(`Tap a glowing spot for your ${cardHtml(sel.card)}.`);
    } else if (sel?.kind === 'pile') {
      lines.push('Tap a glowing pile to slide the whole stack over.');
    } else if (onlyEndTurn) {
      lines.push('Nothing fits — end your turn.');
    } else if (lines.length === 0 || state.lastAction?.player === state.currentPlayer) {
      lines.push('Play down the streets, slide whole piles — Kings take the corners.');
    }
  } else if (lines.length === 0) {
    lines.push('The Mayor is deliberating…');
  }
  $('msg').innerHTML = lines.join(' ');
}

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  const mover = G.state.currentPlayer;
  const fx = {};
  if (move.type === 'move') {
    // capture where the pile is leaving from, for the slide animation
    fx.slide = {
      from: move.from,
      to: move.to,
      count: G.state.piles[move.from].length,
      fromRect: cellEls[move.from].querySelector('.pilecards').getBoundingClientRect(),
    };
  }
  G.state = applyMove(G.state, move);
  save();

  // Pass & play: the instant the turn changes hands, stop showing cards —
  // otherwise the next player's hand flashes on screen before the handoff.
  if (G.mode === 'pass' && G.state.currentPlayer !== mover) handRevealed = false;

  if (move.type === 'play') fx.playedTo = move.to;
  if (move.type === 'draw') { fx.stockBump = true; fx.drew = true; }
  render(fx);

  const status = getStatus(G.state);
  if (status.status !== 'active') {
    setTimeout(() => showGameOver(status), move.type === 'play' ? 900 : 500);
    return;
  }

  const next = G.state.currentPlayer;
  if (next !== mover) {
    if (G.mode === 'bot' && next === BOT) {
      botTimer = setTimeout(botStep, 850);
    } else if (G.mode === 'pass') {
      setTimeout(() => showHandoff(next), 550);
    }
  }
}

function deselect() {
  if (!sel) return;
  sel = null;
  render();
}

function onCardTap(card, el) {
  if (!humanTurn()) return;
  const moves = legalMoves(G.state);
  if (moves.length === 1 && moves[0].type === 'draw') {
    $('msg').innerHTML = 'Draw first — tap the stack.';
    return;
  }
  if (sel?.kind === 'card' && sel.card === card) { deselect(); return; }
  const targets = targetsFor(moves, { kind: 'card', card });
  if (targets.size === 0) {
    el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
    return;
  }
  if (targets.size === 1) {
    sel = null;
    doMove({ type: 'play', card, to: [...targets][0] });
    return;
  }
  sel = { kind: 'card', card };
  render();
}

function onPileTap(id) {
  if (!humanTurn()) return;
  const moves = legalMoves(G.state);
  if (moves.length === 1 && moves[0].type === 'draw') {
    $('msg').innerHTML = 'Draw first — tap the stack.';
    return;
  }
  if (sel?.kind === 'card') {
    if (targetsFor(moves, sel).has(id)) {
      const card = sel.card;
      sel = null;
      doMove({ type: 'play', card, to: id });
    } else {
      deselect();
    }
    return;
  }
  if (sel?.kind === 'pile') {
    if (sel.id === id) { deselect(); return; }
    if (targetsFor(moves, sel).has(id)) {
      const from = sel.id;
      sel = null;
      doMove({ type: 'move', from, to: id });
    } else {
      deselect();
    }
    return;
  }
  // nothing selected: pick up this pile if it can go somewhere
  if (targetsFor(moves, { kind: 'pile', id }).size > 0) {
    sel = { kind: 'pile', id };
    render();
  } else {
    const cell = cellEls[id];
    cell.classList.remove('nope'); void cell.offsetWidth; cell.classList.add('nope');
  }
}

for (const id of PILES) {
  cellEls[id].addEventListener('click', (e) => { e.stopPropagation(); onPileTap(id); });
}

$('stock').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!humanTurn()) return;
  const moves = legalMoves(G.state);
  if (moves.length === 1 && moves[0].type === 'draw') { doMove({ type: 'draw' }); return; }
  $('msg').innerHTML = G.state.stock.length === 0
    ? 'The stack is spent — play what you hold.'
    : 'One draw per turn — play on, or end your turn.';
});

$('endTurnBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!humanTurn()) return;
  if (legalMoves(G.state).some((m) => m.type === 'endTurn')) {
    sel = null;
    doMove({ type: 'endTurn' });
  }
});

$('table').addEventListener('click', deselect);

/* ---------------------------------------------------------------- bot */

function botStep() {
  if (!G || G.mode !== 'bot') return;
  if (getStatus(G.state).status !== 'active' || G.state.currentPlayer !== BOT) return;
  doMove(chooseMove(G.state));
  // doMove re-arms only on turn change; the Mayor keeps going until endTurn:
  if (getStatus(G.state).status === 'active' && G.state.currentPlayer === BOT) {
    botTimer = setTimeout(botStep, 700);
  }
}

/* ---------------------------------------------------------------- flow */

function startGame(mode) {
  clearTimeout(botTimer);
  sel = null;
  G = { mode, state: createInitialState({ numPlayers: 2, seed: newSeed() }) };
  save();
  if (mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render({ dealAll: true });
  }
}

function showHandoff(player) {
  handRevealed = false;
  sel = null;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  handRevealed = true;
  show('game');
  render({ dealAll: true });
});

const WIN_LINES = [
  'Four corners, zero cards — the park is yours.',
  'City Hall should name a bench after that.',
  'Cleaner than Church Street at sunrise.',
  'That was smoother than a creemee in July.',
];

function showGameOver(status) {
  clearTimeout(botTimer);
  save(); // clears the save — game's done
  const title = $('go-title');
  const line = $('go-line');
  const pick = WIN_LINES[(Math.random() * WIN_LINES.length) | 0];

  if (status.status === 'blocked') {
    title.textContent = 'GRIDLOCK!';
    const names = status.winners.map(playerName).join(' & ');
    line.textContent = status.winners.length === 1
      ? `Nobody could move — like Main & St. Paul at 5pm. Fewest cards takes it: ${names} wins!`
      : `Nobody could move, and ${names} tie for fewest cards. Split the maple candy.`;
  } else if (G.mode === 'bot' && status.winner === BOT) {
    title.textContent = 'THE MAYOR TAKES IT';
    line.textContent = 'City Hall wins this round. File for a rematch — democracy encourages it.';
  } else if (G.mode === 'bot') {
    title.textContent = 'YOU WIN! 👑';
    line.textContent = pick + ' The Mayor tips his hat to you.';
  } else {
    title.textContent = playerName(status.winner).toUpperCase() + ' WINS! 👑';
    line.textContent = pick;
  }
  show('gameover');
}

/* ---------------------------------------------------------------- menu */

$('botBtn').addEventListener('click', () => startGame('bot'));
$('passBtn').addEventListener('click', () => startGame('pass'));

$('resumeBtn').addEventListener('click', () => {
  const saved = loadSave();
  if (!saved) { $('resumeBtn').classList.add('hidden'); return; }
  clearTimeout(botTimer);
  sel = null;
  G = saved;
  if (G.mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render({ dealAll: true });
    if (G.state.currentPlayer === BOT) botTimer = setTimeout(botStep, 850);
  }
});

function goMenu() {
  clearTimeout(botTimer);
  sel = null;
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
}

$('homeBtn').addEventListener('click', goMenu);
$('menuBtn').addEventListener('click', goMenu);
$('againBtn').addEventListener('click', () => startGame(G.mode));

/* ---------------------------------------------------------------- boot */

goMenu();
