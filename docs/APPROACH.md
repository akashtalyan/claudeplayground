# FE Learning Game — Approach Doc

**Status:** Draft for discussion
**Last updated:** 2026-07-19

## 1. What we're building

A game that turns your everyday frontend work into a learning loop. Every time
you make an FE change, the game inspects what you actually changed and teaches
you something about it — *what changed, how it works under the hood, and one
way to improve it* — wrapped in game mechanics that make you want to come back.

The key differentiator from every tutorial site: **lessons are generated from
your real diffs**, not from canned exercises. You learn about `useEffect`
cleanup on the day you wrote a `useEffect`, not in week 4 of a course.

## 2. Design principles

1. **Pull, not push.** Lessons should feel like rewards you collect, not
   interruptions that block your flow. Gamification that nags gets uninstalled.
2. **Grounded in real code.** Every lesson must quote or reference the actual
   diff that triggered it. Generic advice is banned.
3. **Small bites.** A lesson is readable in under 2 minutes. Depth comes from
   accumulation, not from any single lesson.
4. **Visible progress.** The player should always be able to *see* what they
   know and — just as important — what they don't (empty branches on the skill
   tree are the product's gentlest form of nagging).
5. **Zero infrastructure to start.** v1 runs entirely inside the repo: git
   hooks + Claude + static files. No backend, no accounts, no database.

## 3. The core loop

```
┌─────────────────────────────────────────────────────────┐
│  1. You commit an FE change (.tsx / .css / .html / .js) │
│  2. A post-commit hook captures the diff                │
│  3. Claude analyzes the diff → structured lesson JSON   │
│     • concepts touched (e.g. flexbox, memoization)      │
│     • what changed (plain-English recap)                │
│     • how it works (the under-the-hood explainer)       │
│     • level-up tip (one concrete improvement)           │
│     • quiz (2–3 questions about YOUR code)              │
│  4. Lesson lands as an unopened "chest" in the dashboard│
│  5. You open chests when YOU want → earn XP, fill the   │
│     skill tree, keep the streak, unlock collectibles    │
└─────────────────────────────────────────────────────────┘
```

The commit hook is silent — it never blocks or prints more than one line.
All the fun lives in the dashboard, visited on your schedule ("loot drop"
model).

## 4. Game design

The mechanics stack in layers. Each layer is shippable on its own; together
they form the full game.

### Layer 1 — Skill tree (progression)

A visual tree of frontend domains: **CSS · DOM · React · Performance ·
Accessibility · Networking · Tooling**. Each lesson grants XP to the branches
its concepts belong to (changed a `useEffect` → +15 XP React Lifecycle).
Over time the tree becomes a map of what you've encountered — and the empty
branches become a map of your blind spots.

### Layer 2 — Concept Pokédex (collection)

Every distinct concept the analyzer detects becomes a collectible card with a
playful identity: *Layout Thrasher*, *Stale Closure*, *Zombie Listener*,
*Specificity Gremlin*. First encounter in a real diff unlocks the card, with
a fun explainer: what it is, how it works, how to tame it. Collection pressure
is a strong motivator and maps 1:1 to "concepts I've met in real code."

### Layer 3 — Quiz duels (interaction)

Opening a chest offers an optional quiz about *your own diff*:

> "This `key={index}` you wrote in `TodoList.tsx` — what happens when the
> list reorders?"

Correct answers multiply the XP. Variants: spot-the-difference (your code vs.
an improved version — guess which is which), predict-the-render-count,
find-the-a11y-issue.

### Layer 4 — Streaks & achievements (retention)

Daily/weekly streaks for opening chests, achievements for milestones
("First Paint": open 1 chest; "Tree Hugger": XP in every branch;
"Gotta Catch 'Em All": 50 concept cards). Cheap to add once layers 1–3 exist.

**Deliberately out of scope for now:** leaderboards/multiplayer. They change
the design significantly (backend, accounts, anti-gaming) — revisit only if
this becomes a team thing.

## 5. Architecture (v1)

```
repo/
├── game/
│   ├── lessons/            # one JSON file per lesson (chest)
│   ├── state.json          # XP per branch, streak, unlocked cards, opened chests
│   ├── concepts.json       # the Pokédex definitions (grows over time)
│   └── dashboard.html      # single-file static dashboard (no build step)
├── .claude/
│   └── hooks/ or skills/   # the lesson-generation command
└── docs/APPROACH.md        # this doc
```

- **Capture:** a `post-commit` git hook (or Claude Code hook) checks whether
  the diff touches FE files; if so, it invokes the lesson generator with the
  diff as input.
- **Lesson brain:** Claude (via Claude Code headless / a slash command like
  `/lesson`) receives the diff and returns a structured JSON lesson. A JSON
  schema keeps output shape reliable:

  ```json
  {
    "id": "2026-07-19-a1b2c3",
    "commit": "a1b2c3",
    "files": ["src/TodoList.tsx"],
    "concepts": [{ "id": "react-keys", "branch": "React", "xp": 15 }],
    "what_changed": "…",
    "how_it_works": "…",
    "level_up_tip": "…",
    "quiz": [{ "q": "…", "choices": ["…"], "answer": 1, "why": "…" }]
  }
  ```

- **Dashboard:** one self-contained HTML file reading the JSON files —
  renders unopened chests, the skill tree, the card collection, and streaks.
  Opened chests update `state.json`.
- **Everything is git-tracked**, so your learning history travels with the
  repo and is diffable/reviewable like anything else.

## 6. Roadmap

| Milestone | Scope | Effort |
|-----------|-------|--------|
| **M1 — Lesson engine** | Hook + Claude generation + lesson JSON on disk. Console output only. | ~1 evening |
| **M2 — Dashboard** | Static dashboard: chest feed, skill tree, XP, streak. | ~1–2 evenings |
| **M3 — Pokédex** | Concept cards with playful identities, unlock animations. | ~1 evening |
| **M4 — Quizzes** | Diff-grounded quiz questions with XP multipliers. | ~1 evening |
| **M5 — Polish** | Achievements, sounds, seasonal events, maybe a Tamagotchi mascot whose mood tracks code health. | ongoing |

## 7. Open questions

1. **Trigger point:** post-commit (more frequent, smaller lessons) vs.
   pre-push/PR (fewer, richer lessons)? Current lean: post-commit.
2. **Which repo(s)?** Just this playground, or installable into any project
   you work on (which argues for packaging it as a Claude Code plugin/skill)?
3. **Quiz honesty:** self-graded is simplest; do we care about "cheating" in
   a single-player game? (Lean: no — it's your own learning.)
4. **Concept taxonomy:** curate the branch/concept list up front, or let
   Claude grow it organically and periodically dedupe? (Lean: seed ~30
   concepts, let it grow.)
