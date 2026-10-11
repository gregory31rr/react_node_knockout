# Knockout — Active Features

The single list of everything Knockout does today. **Update this page in the same pull request as any change that adds,
changes or removes a feature** (see CLAUDE.md).

Last updated: Oct 11, 2026 (PR #4: safe to run on several servers)

**Status key**
- ✅ **Tested**: automated tests click or call it and check the result was saved (`npm test`).
- 🟡 **In the code, not yet tested**: the page or action exists and its page loads, but no automated test proves the action works end to end yet.
- ⚠️ **Limited**: works with a known limitation (noted).

Who can use it: **Manager** = workspace admin · **Member** = team member with an account · **Owner** = Knockout app owner.

---

## Sign-in and accounts
| Feature | Who | Status |
|---|---|---|
| Sign in / sign out (30-day sessions) | Everyone | ✅ |
| Wrong password and missing fields are refused with a message | Everyone | ✅ |
| Signed-out visitors are sent to sign in (also mid-click, from the page script) | Everyone | ✅ |
| Sign up for a new workspace | Everyone | 🟡 |
| Forgot password / reset by email link | Everyone | 🟡 Needs email set up (`RESEND_API_KEY`) to send |
| Accept an invite / join a workspace | Everyone | 🟡 |
| Switch between workspaces | People in 2+ | 🟡 |
| Light / dark mode | Everyone | 🟡 |
| Notifications (🔔) page | Everyone | 🟡 Page loads ✅ |
| Simple view (sticky-note board) ↔ Full view | Everyone | ✅ |

## My board (simple view)
| Feature | Who | Status |
|---|---|---|
| Five columns: Do today · This week · Ask or tell · Waiting · Later | Everyone | ✅ |
| ✓ Done: knock a note out without reloading, with Undo | Everyone | ✅ |
| Move chooser: day, date, waiting / not waiting, Task / Ask / Update / Tell | Owner of note, Manager | ✅ |
| Drag a note between columns, or onto the "Move" box | Owner of note, Manager | ✅ |
| Press and hold a note on a phone or tablet | Owner of note, Manager | ⚠️ Opens the Move chooser; dragging with a finger isn't supported |
| Nudge the person who owns a note (counts per week) | Manager | ✅ |
| Comment on a note, with ready-made replies ("I'm removing the blocker") | Everyone | ✅ |
| Share a note with someone (they get a 🔔) | Owner of note, Manager | ✅ |
| "Talking to someone?" — everything for one person | Everyone | ✅ |
| "See a team member's board" | Manager | ✅ (members can't open others' boards ✅) |
| List a call; at call time, a board of what to ask and tell each person | Manager | ✅ board opens; saving a call 🟡 |
| New note page | Everyone | 🟡 Page loads ✅ |
| Search notes, projects and people | Everyone | ✅ page loads; results 🟡 |
| Failed saves (offline) show an error and change nothing | Everyone | ✅ |

## Items (full view)
| Feature | Who | Status |
|---|---|---|
| Quick add (＋ button or "n" key) with a live preview of @person #project p1 2h fri | Everyone | ✅ |
| Items list with filters that apply as you pick them | Everyone | Page loads ✅; filters 🟡 |
| **Period filter** for reviewing work: Any time · Last 30 / 60 / 90 days · All time (13 months). Works with Open, Knocked out and Everything, and with "Who does it → My team" | Everyone (managers see the team) | ✅ |
| **Completed vs remaining** summary for the period: Completed, Remaining and % done; tap a number to list those items | Everyone | ✅ |
| 🥊 Knock out with Undo | Everyone | ✅ |
| Export items to CSV (uses the same filters, including Period) | Everyone | ✅ |
| New item form | Everyone | 🟡 Page loads ✅ |
| Item page: edit, answer, add a note, log time, delegate, delete (with confirm) | Varies | 🟡 Delete confirm ✅ |
| Share / unshare an item with people | Owner, Manager | ✅ share; unshare 🟡 |
| Copy an item for Teams / Slack, or open it in email | Everyone | ✅ copy |
| Outside link for someone without an account (turn on / off) | Manager, paid plans | 🟡 |
| Outside link page: view, add time and notes, mark done | Anyone with the link | 🟡 |

## People
| Feature | Who | Status |
|---|---|---|
| People list with team / role / project filters | Manager | Page loads ✅; filters 🟡 |
| Capacity view | Manager | 🟡 Page loads ✅ |
| Import people (preview, then import) | Manager | 🟡 |
| Add, edit, give an account (invite), remove (with confirm) | Manager | 🟡 |

## Projects
| Feature | Who | Status |
|---|---|---|
| Projects list and project page | Everyone | 🟡 Pages load ✅ |
| New / edit / mark done or reopen (with confirm) / delete | Manager | 🟡 |

## Calls and 1:1s
| Feature | Who | Status |
|---|---|---|
| Calls list, new call, call page | Manager | ✅ pages load |
| Call notes save by themselves as you type | Manager | ✅ |
| Record a call with the microphone, play it back, delete it | Manager | ✅ (with Chrome's test microphone) ⚠️ Not tried on a real microphone or Safari |
| Recordings stored encrypted | Manager | ✅ round-trip tested |
| Recordings in file storage (DigitalOcean Spaces / S3) when `STORAGE_*` is set; database otherwise | Manager | ✅ (test storage server; signing checked against AWS's published examples) ⚠️ Not yet tried on a real Spaces bucket |
| Deleting a workspace removes all its recordings from storage (refused, with nothing deleted, if storage is down) | Owner, Manager | ✅ |
| Start / end a call, add or remove people, delete a call | Manager | 🟡 |
| Turn a recording into text, with suggested answers | Manager | 🟡 Needs `TRANSCRIBE_API_KEY` |
| Call summary: email it, open in your email, or copy for Teams | Manager | 🟡 Copy ✅; email needs `RESEND_API_KEY` |

## Insights, goals and updates
| Feature | Who | Status |
|---|---|---|
| Insights charts with period / person filters | Everyone | ✅ |
| Insights CSV export | Everyone | ✅ |
| Goals: add and update | Everyone | 🟡 Page loads ✅ |
| Updates for your boss: write, email, save or copy | Manager | 🟡 Page loads ✅ |

## Notes and reminders
| Feature | Who | Status |
|---|---|---|
| Notes: add, pin, archive, edit, turn into an item | Everyone | 🟡 |
| Delete a note (with confirm) | Everyone | ✅ |
| Password warning on notes that look like passwords | Everyone | 🟡 |
| Reminders saved and shown in your own time zone | Everyone | ✅ |
| Reminders: repeat, done, snooze to tomorrow, delete | Everyone | 🟡 |
| "remind me fri 3pm to call Dana" in quick add | Everyone | 🟡 |
| Reminder and call-start notifications (every minute) | Everyone | 🟡 |

## Time off and training
| Feature | Who | Status |
|---|---|---|
| Time off: request, remove (with confirm), CSV | Everyone | 🟡 Pages and CSV ✅ |
| Certifications and courses: add, update, log, CSV | Everyone | 🟡 Pages and CSV ✅ |
| Certificate expiry warnings (hourly) | Everyone | 🟡 |

## Connect, settings and admin
| Feature | Who | Status |
|---|---|---|
| Connect with someone by code (copy my code, accept / decline) | Everyone | 🟡 Copy ✅ |
| Settings: workspace, users, notification choices, my account | Everyone | 🟡 Page loads ✅ |
| Sign out everywhere, export my data, delete workspace | Everyone / Manager | 🟡 |
| Knockout admin console: workspaces, users, sign-ins, activity log, help mode | Owner | 🟡 |
| Paused workspace is read-only | Owner | 🟡 |

## Built in everywhere
| Feature | Status |
|---|---|
| "Are you sure?" before deletes and other one-way actions | ✅ |
| Times shown in each viewer's own time zone | ✅ |
| Forms from other websites refused (CSRF token + origin check) | ✅ |
| Flood protection on changes (120 a minute per person or address; `RATE_PER_MIN`) | ✅ shared by all servers |
| Sign-in lockout: 5 wrong passwords per email or 30 per address in ~15 minutes | ✅ shared by all servers |
| Background chores (reminders, call alerts, expiry warnings, clean-up) run once even with several servers | ✅ |
| Members kept out of manager-only pages | ✅ |
| Security headers, encrypted secrets, hourly clean-up of old sessions | 🟡 |
| Health check `GET /health` | ✅ |
| **PostgreSQL database** for production (`DATABASE_URL`): secure sign-in (SCRAM), encrypted connections, connection pool, all-or-nothing saves | ✅ (whole app suite runs on PostgreSQL) |
| Built-in SQLite database for demos and local use (no `DATABASE_URL`) | ✅ |
| Installable phone app (manifest) | ✅ manifest ⚠️ SVG-only icon; Chrome wants PNG |
| Works on phones (tab bar, big buttons) | 🟡 Not tested on real phones |

## Not yet built (planned)
- Deploy to DigitalOcean (Render as fallback).
- React frontend with an Express API (after production readiness).
