# Knockout — Project Rules and Status

## Current status (updated Oct 11, 2026)

**Repo:** `gregory31rr/react_node_knockout` (working repo). The original `gregory31rr/knockout` is kept untouched as a reference.
Branches: `dev` → `stage` → `main` (production). Work lands in `dev` by pull request.

**Done**
- Baseline copy of knockout committed (recoverable checkpoint).
- Regression test suite: `npm test`, no outside packages. 126 tests on PostgreSQL (98 on SQLite): server, real-Chrome end-to-end, and database-connection tests.
  CI runs it on every push and pull request.
- Missing page script `public/app.js` rebuilt. All interactive features work: confirmations, knock out with Undo,
  board drag and drop, the Move and Share choosers, recording calls, autosave, copy, local time zones.
- Fixed: the `[hidden]` CSS rule was inside a comment; reminders and calls were saved in the wrong time zone.
- Pull requests #1, #2 and #3 are merged into `dev`.
- Items **Period filter** (30 / 60 / 90 days / all time = 13 months) with a completed-vs-remaining summary.
  Definitions: Completed = knocked out in the period; Remaining = still open and added in the period.
- **PostgreSQL support** (`lib/pg.js`, built-in modules only: SCRAM sign-in, TLS via sslmode, pool, transactions).
  The full suite passes on PostgreSQL; CI runs it on both databases.
  Fixed during testing: big answers (recordings) were read quadratically (20 MB: 48 s → 0.3 s).
- **Safe on several servers** (PR #4, `feature/multi-server`): sign-in lockout and flood protection count in the database
  (`lib/limits.js`, table `ko_counters`, migration 1); background chores take a PostgreSQL advisory lock so they run once.
  Proven by tests running 2 servers and 4 chore processes on one database (old code: reminders sent ×4).
- **Recordings in file storage** (PR #5, `feature/recording-storage`): `lib/s3.js` (S3/Spaces client, built-in modules,
  signing verified against AWS's published examples), `lib/recordings.js` (database by default; Spaces when
  `STORAGE_*` is set; encrypted either way), migration 2 (`recordings.object_key`). Workspace deletion removes the
  workspace's whole storage folder first and refuses if storage is down. Tested with `test/helpers/fakes3.js`.

**Known gaps (not fixed yet)**
- Recordings: file storage is built (PR #5) but not yet tried on a real Spaces bucket. Uploads and playback are still
  read whole into memory (up to 40 MB each, plus decryption); streaming them is a later improvement.
- The app-install (PWA) icon is SVG only; Chrome wants PNG icons.
- Press-and-hold on touch screens opens the Move chooser; it does not support dragging with a finger.
- Not tested: real phones, Safari, Firefox and a real microphone.

## Features page (owner's request)
`FEATURES.md` is the single list of every active feature, with its test status.
**Update it in the same pull request as any change that adds, changes or removes a feature.**
When a feature gets tests, move it from 🟡 to ✅. Never mark something ✅ unless an automated test proves it.

## Hosting decision
- **DigitalOcean App Platform first**, with managed PostgreSQL. **Render is the fallback** if DigitalOcean causes trouble.
- Keep everything host-neutral: standard Node, a `DATABASE_URL` setting and `GET /health`. Switching hosts should be a configuration change, not a rewrite.
- The owner (Greg) creates the accounts and enters payment. Claude never handles payment.
- Deploys run from GitHub Actions using the repo secret `DIGITALOCEAN_ACCESS_TOKEN`. Claude never sees the token.
- Check current prices and options before any paid resource is created.

## Next steps (in order)
1. Merge PR #1 after review.
2. ~~Restore PostgreSQL support~~ Done (PR #3). Local testing: a PostgreSQL 16 server is installed in Claude's workspace
   (`/usr/lib/postgresql/16/bin`); run it as the `postgres` user with SCRAM + TLS, then `TEST_DATABASE_URL=… npm test`.
3. Scale blockers: ~~shared rate limiter~~ and ~~run-once jobs~~ done (PR #4, in the database, no Redis needed).
   ~~Recordings to object storage~~ done (PR #5); try on a real Spaces bucket once the account exists.
   Left: streaming uploads/playback (memory), monitoring.
4. Once the DigitalOcean account and token exist: write the deploy workflow, create the Spaces bucket and keys
   (set STORAGE_* on the app), deploy `stage` and then `main`, and verify `/health` and a recording on the live site.
5. Later, only after production readiness: move the UI to React with an Express API, one area at a time.
   This is a maintainability choice; it does not help the app scale.

## Stack
- Today: Node.js 22.13+ using only built-in modules (its own small web framework in `lib/app.js`),
  server-rendered pages with `public/app.js`, SQLite locally, PostgreSQL in production (`lib/pg.js`).
- Planned (step 5 above): a React frontend with an Express backend (routes → controllers → services → data layer).

## Running it
- Demo: `npm run demo`, then open http://localhost:3000 and sign in as `greg@demo.test` / `demo1234`
  (team member: `priya@demo.test`).
- Features: `FEATURES.md` lists every active feature and its test status.
- Tests: `npm test`. Browser tests need Chrome; set `CHROME_PATH` if it isn't found.
- In the browser with no install: GitHub Codespaces (see `.devcontainer/`). It starts the demo automatically.

## MANDATORY SOFTWARE DEVELOPMENT RULES
You are working on an existing production-oriented application.
Your highest priority is preserving existing functionality while implementing new features.

### RULE 1: NEVER BREAK EXISTING FEATURES
Before modifying code:
1. Identify the files that will change.
2. Identify every feature that depends on those files.
3. Identify shared functions, APIs, database tables, and event handlers.
4. Explain potential regression risks.
5. Preserve existing behavior unless explicitly instructed otherwise.

Do not rewrite entire files unnecessarily.
Do not remove existing functionality to make new functionality work.

### RULE 2: COMPLETE END-TO-END FUNCTIONALITY
A feature is NOT complete simply because the interface exists.
Every button, form, menu, link, and interactive element must have a working implementation.
Verify the complete pathway:
User interaction → JavaScript handler → Backend → Database or external service → Response → Updated interface.
If a feature requires authentication, authorization, notifications, file storage, or additional processing, verify those components too.
Do not create placeholder functionality and claim the feature is complete.

### RULE 3: AUTOMATED REGRESSION TESTING
Before modifying code, run the existing automated tests and record the results.
After modifying code:
1. Run tests for the new feature.
2. Run tests for related existing features.
3. Run the full regression test suite.
4. Verify database operations.
5. Verify API responses.
6. Verify navigation and user permissions.
7. Check browser and server errors.

If tests do not exist, create appropriate tests before making high-risk changes.
Do not claim that functionality was tested unless tests actually executed.

### RULE 4: LIMIT CHANGES
Only modify code necessary to implement the requested feature.
Avoid unrelated refactoring, renaming, restructuring, dependency changes, or database modifications.
If a broader change is required, explain why before implementing it.

### RULE 5: VERIFY EVERY USER PATHWAY
For every new feature, test:
- Successful operation
- Invalid input
- Missing data
- Permission restrictions
- Database failures
- Navigation between pages
- Refreshing the page
- Saving and retrieving information

Do not consider the feature complete until the applicable pathways work.

### RULE 6: PRESERVE WORKING VERSIONS
Before implementing changes, create a Git commit or other recoverable checkpoint.
If the change causes regressions that cannot be resolved safely, restore the last working version.
Never destroy the last known working application.

### RULE 7: PROVIDE A COMPLETION REPORT
After implementation, report:
1. Files modified
2. Features added
3. Existing features affected
4. Tests actually executed
5. Tests passed
6. Tests failed
7. Untested pathways
8. Remaining risks

Never report that everything works without supporting verification.
If browser testing, database access, or another required testing capability is unavailable, explicitly state what could not be verified.

### RULE 8: NO FAKE FUNCTIONALITY
Never substitute fake data, simulated success messages, placeholder buttons, or hardcoded responses for actual functionality unless explicitly requested.
If a feature is incomplete, clearly label it incomplete.

## PRIMARY OBJECTIVE
Build reliable, maintainable software where adding a new feature does not destroy previously working functionality.
