# Kings Corner — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the rules and architecture — this file adds the
rules an agent needs. Stephen is non-technical — explain consequential
changes in plain language.

## What this is

Kings Corner for Btown Games, City-Hall-Park-themed (the foundations are
Church Street cross-streets; the corners are the corners of the park).
Plain static site, **no build step**: `index.html` + `style.css` + ES modules
in `js/`. Deployed by GitHub Pages via `.github/workflows/deploy.yml` on push.
No backend, no accounts, no analytics.

## The one non-negotiable

**Every rule of the game lives in `js/engine.js` and nowhere else.** It's
pure functions over one JSON-serializable state object: `createInitialState`,
`legalMoves`, `applyMove` (returns a NEW state, never mutates), `getStatus`.
It imports nothing and never touches the DOM, timers, `Date`, or
`Math.random` — the shuffle runs on a seeded RNG whose state lives inside
the game state. A game must survive `JSON.stringify` → `JSON.parse` → resume.

Why: online multiplayer gets bolted on later by syncing that exact state
object between phones. Rule logic in `main.js` or `bot.js` silently breaks
that plan. `js/bot.js` may only call the engine's public API; `js/main.js`
is UI only.

## Online play (the rooms layer)

`js/rooms.js` is the fleet's vendored online-multiplayer client — the
canonical copy lives in `four-in-a-rowboat`; copy it verbatim from there.
It talks to the shared Supabase rooms backend
(`btownbrief.github.io/supabase/rooms-2026-07-30.sql`): a room is a 4-letter
code + the entire engine state as opaque JSON + a version number. After a
move, the moving phone pushes the new state with the version it last saw;
everyone else polls. All rules stay in `engine.js` — `rooms.js` knows
nothing about Kings Corner. The host sits in engine seat 0, the player
`createInitialState()` makes first; the joiner is seat 1. Online UI renders
only this phone's hand and shows the opponent's card count. If the backend
SQL isn't installed yet, the client gets a clean `not_ready` error and the
UI says online play isn't switched on.

`scripts/rooms-shim.mjs` is the verbatim local stand-in from
`four-in-a-rowboat`, so everything is testable offline:
`scripts/test-rooms.mjs` drives the real client and engine through an online
game against it.

## Before you finish

Run `node scripts/test-engine.mjs` — plain Node, no framework, must pass.
If you touched `rooms.js`, `main.js`'s online section, or the shim, also run
`node scripts/test-rooms.mjs`.
If you touched the engine, add assertions for the new behavior. If you
touched the UI, load the game at a phone-sized viewport and play a hand
(vs the Mayor AND pass-and-play), or clearly say you couldn't and what you
inspected instead. Say what you verified.
