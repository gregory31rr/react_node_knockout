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

## Layout

- `server.js`: starts the app and routes each request
- `routes/`: one file per area (board, items, people, projects, calls, notes, time off, training, insights, admin…)
- `lib/`: database (`db.js`, `schema.js`), shared app helpers, email, metrics and background jobs
- `seed.js`: demo data
- `public/`: stylesheet and icon

## Known gap

`lib/pg.js` (the PostgreSQL connection that `lib/db.js` loads when `DATABASE_URL` is set) was not part of
the code recovered from the browser demo. Locally and in the demo the app uses SQLite, so it runs fine;
it needs to be added back before production runs on PostgreSQL.
