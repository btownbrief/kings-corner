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
import { OnlineMatch, savedSession, clearSession, getName } from './rooms.js';

const SAVE_KEY = 'kings-corner-save-v1';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is the Mayor

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 }; // alternate colors in the fan
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';
const MAX_SHOWN = 4;   // cards visibly cascaded per pile

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
const onlinePanel = $('onlinePanel');
const opTitle = $('opTitle');
const opName = $('opName');
const opCodeWrap = $('opCodeWrap');
const opCode = $('opCode');
const opError = $('opError');
const lobbyEl = $('lobby');
const lobbyCode = $('lobbyCode');
const rejoinBtn = $('rejoinBtn');

let G = null;             // { mode: 'bot' | 'pass' | 'online', state }
let sel = null;           // { kind: 'card', card } | { kind: 'pile', id } | null
let handRevealed = true;  // pass & play: false until the handoff button is tapped
let botTimer = null;
let gameOverTimer = null;
let online = null;        // { match, myPlayer } while seated at an online table
let onlineBusy = false;   // one rooms-layer push at a time

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const suitSpan = (card) =>
  `<span class="${isRed(card) ? 'red' : ''}">${SUIT_CHAR[suitOf(card)]}</span>`;
const cardHtml = (card) => `${rankChar(card)}${suitSpan(card)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'The Mayor' : 'You';
  if (G.mode === 'online') {
    if (p === online.myPlayer) return 'You';
    return online.match.opponents().find((opp) => opp.seat === p)?.name || 'Your neighbor';
  }
  return 'Player ' + (p + 1);
}

function humanTurn() {
  if (!G || getStatus(G.state).status !== 'active') return false;
  if (G.mode === 'bot') return G.state.currentPlayer !== BOT;
  if (G.mode === 'online') {
    return !onlineBusy && online.match.status === 'playing' &&
      G.state.currentPlayer === online.myPlayer;
  }
  return true;
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G?.mode === 'online') return;
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
    if (G.mode === 'online' && p === online.myPlayer) continue;
    const chip = document.createElement('div');
    chip.className = 'opp' + (state.currentPlayer === p ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = G.mode === 'bot'
      ? '🎩 The Mayor'
      : G.mode === 'online'
        ? online.match.opponents().find((opp) => opp.seat === p)?.name || 'Your neighbor'
        : 'P' + (p + 1);
    const count = document.createElement('span');
    count.className = 'opp-count';
    count.textContent = state.hands[p].length;
    chip.append(name, count);
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
      el.style.top = `calc(${i} * var(--cascade))`;
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

  // Online state contains both hands for syncing, but this honest UI renders
  // only this phone's seat. The opponent gets a count in the top bar.
  const handOwner = G.mode === 'bot' ? 0
    : G.mode === 'online' ? online.myPlayer : state.currentPlayer;
  $('handLabel').textContent = G.mode === 'bot' || G.mode === 'online'
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
    const who = esc(playerName(last.player));
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
    if (G.mode === 'online') {
      const opp = online.match.opponents()[0] || {};
      lines.push(opp.away
        ? `${esc(opp.name || 'Your neighbor')} stepped away from the table…`
        : `Waiting on ${esc(opp.name || 'your neighbor')}…`);
    } else {
      lines.push('The Mayor is deliberating…');
    }
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
  if (G.mode === 'online') onlineBusy = true;
  else save();

  // Pass & play: the instant the turn changes hands, stop showing cards —
  // otherwise the next player's hand flashes on screen before the handoff.
  if (G.mode === 'pass' && G.state.currentPlayer !== mover) handRevealed = false;

  if (move.type === 'play') fx.playedTo = move.to;
  if (move.type === 'draw') { fx.stockBump = true; fx.drew = true; }
  render(fx);

  const finishMove = () => {
    const status = getStatus(G.state);
    if (status.status !== 'active') {
      clearTimeout(gameOverTimer);
      const activeGame = G;
      gameOverTimer = setTimeout(() => {
        if (G === activeGame && getStatus(G.state).status !== 'active') showGameOver(status);
      }, move.type === 'play' ? 900 : 500);
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
  };

  if (G.mode === 'online') {
    const activeMatch = online.match;
    pushOnline().then((accepted) => {
      if (!online || online.match !== activeMatch || !G) return;
      onlineBusy = false;
      if (!accepted) {
        if (getStatus(G.state).status === 'active') render();
        return;
      }
      finishMove();
      if (getStatus(G.state).status === 'active') render();
    });
  } else {
    finishMove();
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
$('stock').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  e.currentTarget.click();
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
  clearTimeout(gameOverTimer);
  sel = null;
  online = null;
  onlineBusy = false;
  G = { mode, state: createInitialState({ numPlayers: 2, seed: newSeed() }) };
  $('againBtn').classList.remove('hidden');
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
  } else if (G.mode === 'online') {
    const iWon = status.winner === online.myPlayer;
    title.textContent = iWon ? 'YOU WIN! 👑' : `${playerName(status.winner).toUpperCase()} WINS! 👑`;
    line.textContent = iWon
      ? pick + ' Your neighbor tips their hat.'
      : 'The park table has a new monarch. Call for another deal.';
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
  clearTimeout(gameOverTimer);
  sel = null;
  if (online) {
    online.match.leave();
    online = null;
    onlineBusy = false;
    G = null;
  }
  $('homeBtn').dataset.armed = '';
  $('homeBtn').textContent = '🏠';
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
  refreshRejoin();
}

$('homeBtn').addEventListener('click', () => {
  if (online && $('homeBtn').dataset.armed !== '1') {
    $('homeBtn').dataset.armed = '1';
    $('homeBtn').textContent = 'LEAVE?';
    setTimeout(() => {
      $('homeBtn').dataset.armed = '';
      $('homeBtn').textContent = '🏠';
    }, 2500);
    return;
  }
  goMenu();
});
$('menuBtn').addEventListener('click', goMenu);
$('againBtn').addEventListener('click', () => {
  if (G.mode === 'online') onlineRematch();
  else startGame(G.mode);
});

/* ------------------------------------------------------------- online play */
// Two phones share the engine's complete JSON state through js/rooms.js.
// Seat 0 hosts and is the player createInitialState() makes first. Remote
// states repaint cold: pile-slide diffs are ambiguous, while a full render
// safely handles multi-play turns, conflict truth, resume, and rematches.

const GAME = 'kings-corner';
let panelIntent = 'host';
let pollErrors = 0;

$('hostBtn').addEventListener('click', () => openPanel('host'));
$('joinBtn').addEventListener('click', () => openPanel('join'));
$('opCancel').addEventListener('click', closePanel);
$('opGo').addEventListener('click', onlineGo);
$('lobbyCancel').addEventListener('click', cancelLobby);
rejoinBtn.addEventListener('click', rejoinTable);
opCode.addEventListener('input', () => {
  opCode.value = opCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
[opName, opCode].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onlineGo();
}));

function openPanel(intent) {
  panelIntent = intent;
  opTitle.textContent = intent === 'host' ? 'OPEN A TABLE' : 'JOIN A TABLE';
  $('opGo').textContent = intent === 'host' ? 'GET A CODE' : 'TAKE A SEAT';
  opCodeWrap.classList.toggle('hidden', intent === 'host');
  opError.classList.add('hidden');
  opName.value = opName.value || getName();
  onlinePanel.classList.remove('hidden');
  (intent === 'join' && opName.value ? opCode : opName).focus();
}

function closePanel() {
  onlinePanel.classList.add('hidden');
}

const FRIENDLY_ERRORS = {
  not_found: 'No table with that code — check the letters.',
  room_full: 'That park table already has two players.',
  room_started: 'That deal is already underway.',
  not_ready: "Online play isn't switched on yet — check back soon!",
  offline: "Can't reach the park — are you online?",
};

function friendly(err) {
  if (err?.code === 'wrong_game') {
    return `That code is for ${String(err.detail || 'another game').replace(/-/g, ' ')} — head there to use it.`;
  }
  return FRIENDLY_ERRORS[err?.code] || 'The cards blew off the table — please try again.';
}

async function onlineGo() {
  if ($('opGo').disabled) return; // Enter key can't double-submit
  const name = opName.value.trim();
  if (!name) {
    opError.textContent = 'Put a name on your seat.';
    opError.classList.remove('hidden');
    opName.focus();
    return;
  }

  const go = $('opGo');
  go.disabled = true;
  opError.classList.add('hidden');
  try {
    if (panelIntent === 'host') {
      const match = await OnlineMatch.create({
        game: GAME,
        name,
        state: createInitialState({ numPlayers: 2, seed: newSeed() }),
        seats: 2,
      });
      closePanel();
      openLobby(match);
    } else {
      const code = opCode.value.trim();
      if (code.length !== 4) {
        opError.textContent = 'The park code is 4 letters.';
        opError.classList.remove('hidden');
        opCode.focus();
        return;
      }
      const match = await OnlineMatch.join({ game: GAME, code, name });
      closePanel();
      enterOnlineGame(match);
    }
  } catch (err) {
    opError.textContent = friendly(err);
    opError.classList.remove('hidden');
  } finally {
    go.disabled = false;
  }
}

function openLobby(match) {
  if (lobbyEl._match && lobbyEl._match !== match) lobbyEl._match.stop();
  lobbyCode.textContent = match.code;
  lobbyEl.classList.remove('hidden');
  match.start({
    onStatus: (status) => {
      if (status === 'playing') {
        lobbyEl.classList.add('hidden');
        enterOnlineGame(match);
      }
    },
    onError: () => {},
  });
  lobbyEl._match = match;
}

function cancelLobby() {
  const match = lobbyEl._match;
  if (match) match.leave();
  lobbyEl._match = null;
  lobbyEl.classList.add('hidden');
  refreshRejoin();
}

async function rejoinTable() {
  rejoinBtn.disabled = true;
  try {
    const match = await OnlineMatch.resume({ game: GAME });
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    // Only a room that's truly gone forfeits the session — a flaky
    // connection must not delete the one path back to the game.
    if (err && (err.code === 'not_found' || err.code === 'not_seated' || err.code === 'room_started')) {
      clearSession(GAME);
      refreshRejoin();
    }
  } finally {
    rejoinBtn.disabled = false;
  }
}

function refreshRejoin() {
  const saved = savedSession(GAME);
  rejoinBtn.classList.toggle('hidden', !saved);
  if (saved) rejoinBtn.textContent = `↩ REJOIN PARK TABLE (${saved.code})`;
}

function enterOnlineGame(match) {
  clearTimeout(botTimer);
  clearTimeout(gameOverTimer);
  online = { match, myPlayer: match.seat };
  onlineBusy = false;
  pollErrors = 0;
  sel = null;
  handRevealed = true;
  G = { mode: 'online', state: match.state };
  $('againBtn').classList.remove('hidden');
  show('game');
  render({ dealAll: true });
  match.start({
    onState: onRemoteState,
    onStatus: onRemoteStatus,
    onPresence: onRemotePresence,
    onError: onPollError,
  });
  if (match.status === 'over' && getStatus(G.state).status === 'active') {
    onRemoteStatus('over');
  }
}

function onRemoteState(newState) {
  if (!online) return;
  clearTimeout(gameOverTimer);
  G.state = newState;
  sel = null;
  onlineBusy = false;
  const status = getStatus(G.state);
  if (status.status === 'active') {
    $('againBtn').classList.remove('hidden');
    show('game');
    render();
  } else {
    render();
    showGameOver(status);
  }
}

function onRemoteStatus(status) {
  if (status !== 'over' || !online || getStatus(G.state).status !== 'active') return;
  const opp = online.match.opponents()[0];
  if (!opp?.left) return;
  $('go-title').textContent = `${(opp.name || 'Your neighbor').toUpperCase()} LEFT THE PARK`;
  $('go-line').textContent = 'The table is packed up for now.';
  $('againBtn').classList.add('hidden');
  show('gameover');
}

function onRemotePresence(opponents) {
  const opp = opponents[0];
  pollErrors = 0;
  if (opp?.left) $('againBtn').classList.add('hidden');
  if (!onlineBusy && screens.game.classList.contains('hidden') === false) {
    render();
  }
}

function onPollError(err) {
  if (!online) return;
  if (err?.code === 'not_found') {
    online.match.stop();
    clearSession(GAME);
    online = null;
    onlineBusy = false;
    G = null;
    show('menu');
    refreshRejoin();
    return;
  }
  pollErrors++;
  if (pollErrors >= 3 && G && getStatus(G.state).status === 'active') {
    $('msg').textContent = 'The connection is stuck at Main & St. Paul — hang tight…';
  }
}

async function pushOnline() {
  const match = online.match;
  const proposed = G.state;
  const over = getStatus(proposed).status !== 'active';
  try {
    await match.push(proposed, { over });
    pollErrors = 0;
    return true;
  } catch (err) {
    if (!online || online.match !== match || !G) return false;
    if (err?.code === 'version_conflict') {
      G.state = match.state;
      sel = null;
      render();
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!online || online.match !== match || !G || G.state !== proposed) return false;
    try {
      await match.push(proposed, { over });
      pollErrors = 0;
      return true;
    } catch (retryErr) {
      if (retryErr?.code !== 'version_conflict') onPollError(retryErr);
      if (!online || online.match !== match || !G) return false;
      G.state = match.state;
      sel = null;
      render();
      return false;
    }
  }
}

async function onlineRematch() {
  if (!online || onlineBusy) return;
  const match = online.match;
  clearTimeout(gameOverTimer);
  const fresh = createInitialState({ numPlayers: 2, seed: newSeed() });
  G.state = fresh;
  sel = null;
  onlineBusy = true;
  show('game');
  render({ dealAll: true });
  try {
    await match.push(fresh);
    pollErrors = 0;
  } catch (err) {
    if (!online || online.match !== match || !G) return;
    if (err?.code === 'version_conflict') {
      G.state = match.state;
    } else {
      onPollError(err);
      G.state = match.state;
    }
  } finally {
    if (!online || online.match !== match || !G) return;
    onlineBusy = false;
    const status = getStatus(G.state);
    if (status.status === 'active') {
      show('game');
      render();
    } else {
      showGameOver(status);
    }
  }
}

/* ---------------------------------------------------------------- boot */

goMenu();
refreshRejoin();
