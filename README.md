# Knockout

Track, delegate and knock out your work. Node.js with no outside packages; PostgreSQL in production, built-in SQLite for local tries.

## Run it locally

Needs Node 22.13 or newer.

```bash
SEED_DEMO=1 node server.js        # or: npm run demo
```

Open http://localhost:3000 and sign in as `greg@demo.test` / `demo1234` (team member: `priya@demo.test`).
Health check: `GET /health`.

## Stages

| Branch  | Environment   | Purpose                              |
|---------|---------------|--------------------------------------|
| `dev`   | `development` | Day-to-day work lands here           |
| `stage` | `staging`     | Release candidate, test before prod  |
| `main`  | `production`  | Live                                 |

Work goes into `dev` by pull request, then `dev` → `stage` to test, then `stage` → `main` to release.
CI checks every file and boots the app with demo data on every push and pull request.

## Tests

```bash
npm test                  # everything: server tests + browser tests
node test/run.js http     # just the server tests
node test/run.js browser  # just the browser tests (needs Chrome; set CHROME_PATH if it isn't found)
```

No packages to install. Each test file starts its own server on a throwaway SQLite database with the demo
data, so tests never touch real data. Browser tests drive a real headless Chrome through its built-in
debugging protocol: click, then check the page changed, then reload to check it really saved.
Without Chrome the browser tests are reported as skipped, never as passed.

## Layout

- `server.js`: starts the app and routes each request
- `routes/`: one file per area (board, items, people, projects, calls, notes, time off, training, insights, admin…)
- `lib/`: database (`db.js`, `schema.js`), shared app helpers, email, metrics and background jobs
- `seed.js`: demo data
- `public/`: stylesheet, icon and `app.js` (the page script: knock out, drag and drop, Move/Share choosers, recording, …)
- `test/`: regression tests (`npm test`)
- `FEATURES.md`: every active feature and its test status (kept up to date with each change)

## Known gap

`lib/pg.js` (the PostgreSQL connection that `lib/db.js` loads when `DATABASE_URL` is set) was not part of
the code recovered from the browser demo. Locally and in the demo the app uses SQLite, so it runs fine;
it needs to be added back before production runs on PostgreSQL.
