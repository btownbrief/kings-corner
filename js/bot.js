/* The Mayor — picks a move using ONLY the engine's public API.
 * No rule logic lives here: the bot chooses among legalMoves(state).
 *
 * Greedy heuristic, one move per call (the UI paces the turn):
 *  - Draw when the engine says that's the move.
 *  - Prefer whole-pile moves — every legal pile move frees up a foundation
 *    slot (only foundations can move; corner piles never budge). Claim an
 *    empty corner first, then slide onto an occupied corner, biggest pile
 *    first.
 *  - Then shed from the hand: Kings to open corners, then whatever fits an
 *    existing pile (lowest rank first — low cards are the hard ones to
 *    place later), then fill an emptied foundation with the highest card.
 *  - Nothing left: end the turn.
 *
 * Termination: pile moves strictly shrink the set of occupied foundations,
 * and refilling one always costs a hand card, so a turn can't loop forever.
 */

import { legalMoves, rankOf, RANKS, CORNERS } from './engine.js';

const rankIndex = (card) => RANKS.indexOf(rankOf(card));

export function chooseMove(state) {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0]; // forced draw, or a bare endTurn

  const pileMoves = moves.filter((m) => m.type === 'move');
  if (pileMoves.length > 0) {
    let best = pileMoves[0];
    let bestScore = -1;
    for (const move of pileMoves) {
      const cornerScore = CORNERS.includes(move.to)
        ? (state.piles[move.to].length === 0 ? 200 : 100)
        : 0;
      const score = cornerScore + state.piles[move.from].length;
      if (score > bestScore) { bestScore = score; best = move; }
    }
    return best;
  }

  const plays = moves.filter((m) => m.type === 'play');
  if (plays.length > 0) {
    let best = plays[0];
    let bestScore = -1;
    for (const move of plays) {
      const emptyTarget = state.piles[move.to].length === 0;
      let score;
      if (emptyTarget && CORNERS.includes(move.to)) {
        score = 300; // a King in a corner — the whole point of the game
      } else if (!emptyTarget) {
        score = 200 + (12 - rankIndex(move.card)); // shed low cards while they fit
      } else {
        score = 100 + rankIndex(move.card); // seed an empty street with a high card
      }
      if (score > bestScore) { bestScore = score; best = move; }
    }
    return best;
  }

  return moves.find((m) => m.type === 'endTurn');
}
