# KINGS CORNER 👑🌳

Kings Corner on **the City Hall Park table** — the four foundations are
Church Street cross-streets, the four corners are the corners of City Hall
Park, and only Kings may claim them. Play against **the Mayor**, or pass
the phone across the table. Part of
[Btown Games](https://play.btownbrief.com), the browser arcade of the
[BTown Brief](https://www.btownbrief.com).

**Play it live:** https://play.btownbrief.com/kings-corner/

## House rules

- 2–4 players, 7 cards each. The stock sits in the middle of the park and
  four cards are flipped to the cross-streets (Pearl, Cherry, Main, Bank).
  The four park corners start empty — **Kings only**.
- On your turn, **first draw one card** from the stock, then play as many
  cards as you can.
- A card plays on any pile if it's **one rank lower and the opposite
  color** of that pile's exposed card (Ace is low).
- You can slide an **entire pile** onto another pile if the moved pile's
  bottom card fits the target the same way. A foundation pile based on a King
  may move to an empty corner; corner piles never move.
- An emptied cross-street can be restarted with **any** card from your hand.
- First player to shed every card **wins immediately**, mid-turn.
- Stock runs out? Play continues without drawing. If the stock is out and a
  full lap of turns goes by with nobody playing anything, it's gridlock —
  fewest cards wins, so a game can never hang.

## How it works

Plain static site — no build step. `index.html` + `style.css` + ES modules in `js/`:

| file | what it does |
| --- | --- |
| `js/engine.js` | **all** the rules, as pure functions over one JSON-serializable state object (seeded RNG lives in the state — same seed, same deal; supports 2–4 players) |
| `js/bot.js` | the Mayor's brain — picks among the engine's legal moves, preferring pile slides that free up foundation slots, then Kings to corners, then shedding what fits |
| `js/main.js` | UI only: screens, tap-to-select-and-place, the pile-slide animation, bot pacing, pass-the-phone handoffs, localStorage resume |
| `js/leaderboard.js` | monthly leaderboard client (Supabase); vs-Mayor wins only, no accounts |

The engine/UI split is deliberate: online multiplayer later just means
syncing the engine's state object between phones. Rule logic anywhere
outside `engine.js` breaks that plan — see `AGENTS.md`.

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Testing

```bash
node scripts/test-engine.mjs
```

Plain Node, no framework. Covers the descending alternating-color rule,
whole-pile moves, Kings-only corners, refilling emptied foundations, the
draw-then-play turn order, instant win detection, blocked-table endings,
deterministic deals per seed, serialization round-trips, and a 600-game
bot-vs-bot soak across 2–4 players.
