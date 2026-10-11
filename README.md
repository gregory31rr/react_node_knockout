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

## PostgreSQL

Set `DATABASE_URL` and Knockout uses PostgreSQL; leave it empty and it uses the built-in SQLite file.

```bash
DATABASE_URL="postgres://user:password@host:5432/db?sslmode=require" node server.js
```

The connection (`lib/pg.js`) uses only Node's built-in modules: SCRAM-SHA-256 sign-in (what managed databases use) and
encryption set by `sslmode` (`disable`, `prefer`, `require`, `verify-ca`, `verify-full` with `PGSSLROOTCERT`).
Tables are created on first start. Optional: `PG_POOL_MAX` (connections per server, default 10).

Run the tests on PostgreSQL: `TEST_DATABASE_URL="postgres://user:pass@localhost:5432/postgres" npm test`
(each test file gets its own new database, dropped afterwards). CI runs the suite on both databases.

## Call recordings

By default recordings are kept in the database. For production, keep them in S3-compatible file storage
(DigitalOcean Spaces) so the database and its backups stay small: set `STORAGE_ENDPOINT`, `STORAGE_REGION`,
`STORAGE_BUCKET`, `STORAGE_KEY` and `STORAGE_SECRET` (see `.env.example`). Recordings are encrypted by Knockout
before they're stored, either way. Recordings already in the database keep playing after the switch.
Deleting a workspace removes all of its files from storage first; if storage can't be reached, nothing is deleted.
