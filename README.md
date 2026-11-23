# wristplan

Reads your activities from Garmin and builds workouts to schedule on intervals.icu. A Next.js app. Implemented now: activity sync from Garmin (Personal API), the workout builder and templates, scheduling and publishing workouts to intervals.icu, a week/month calendar comparing planned and completed workouts, and a read-only dashboard with volume and trend tables.

Works with Garmin Connect and intervals.icu; not affiliated with Garmin or intervals.icu.

## Requirements

- Node 22: `.nvmrc` pins it, `engines` requires >=22.13 and `engine-strict=true` makes `pnpm install` fail on another version. Run `nvm use`.
- pnpm 9.15.4 (`packageManager`): `corepack enable`, or `npm i -g pnpm@9.15.4`.
- `better-sqlite3` normally installs from a prebuilt binary. pnpm may warn that the `prisma` build script was ignored; this is harmless. `pnpm install` also runs `prisma generate` (postinstall) and `lefthook install` (prepare, installs git hooks).

## Setup

```sh
nvm use
corepack enable
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

`.env.example` already sets `DATABASE_URL=file:./dev.db`, the only required variable. `pnpm db:migrate` (`prisma migrate deploy`) loads `.env` (without it the script fails with `node: .env: not found`, exit code 9) and creates the SQLite file; relative `file:` paths resolve from the repo root. The app is served at http://127.0.0.1:3000.

The app runs with no keys: the workout builder, the calendar and the dashboard work on an empty database (the home page shows "No activities yet."), sync answers 503 and publishing fails as not configured. Sync needs `GARMIN_PERSONAL_API_KEY`; scheduling and publishing need `INTERVALS_API_KEY` and `INTERVALS_ATHLETE_ID` (default `0`, the owner of the key). Add them to `.env` and restart `pnpm dev`. With a warm package cache, install plus migrate takes about 20 seconds and `pnpm verify` plus `pnpm build` about a minute more.

## Verify your setup

```sh
pnpm verify
pnpm build
pnpm exec playwright install chromium   # once, only for e2e
pnpm e2e
```

`verify`, `typecheck` and `build` need `DATABASE_URL` (from `.env` or exported). The first e2e run needs the browser download above.

## Get your keys

- intervals.icu: generate an API key in `/settings` on intervals.icu (Developer Settings, near the bottom of the page; see the [forum post on API access](https://forum.intervals.icu/t/api-access-to-intervals-icu/609)). Leave `INTERVALS_ATHLETE_ID` at `0` to use the athlete tied to the key, or set your athlete id.
- Garmin: obtain a Personal API key through the [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/). It is read-only, wristplan exchanges it for a 24 h access token, and the key itself expires.

Put keys only in `.env`; never commit them.

## First run

Open http://127.0.0.1:3000. Create a workout at `/workouts/new`, then schedule it from `/calendar`. With a Garmin key, press **Sync now** on the home page to import activities; the calendar and `/dashboard` fill in from the stored activities.

## Running it safely

wristplan has no authentication and is for local single-user use. It binds to `127.0.0.1`; do not expose or port-forward it. `ALLOWED_HOSTS` adds extra hostnames (for example a reverse-proxy name) to the Host allow-list described under Syncing activities.

## Syncing activities

Open http://127.0.0.1:3000 and press **Sync now** to import Garmin activities into the local database. Requires `GARMIN_PERSONAL_API_KEY`; without it the sync endpoint (`POST /api/sync`) answers 503. The page lists stored activities and offers the FIT file download where one was fetched.

wristplan is a single-user app with no authentication. `pnpm dev` and `pnpm start` bind to `127.0.0.1` only; do not expose it to a network or the internet. As a defence against DNS rebinding, the sync and FIT endpoints and the home page accept only `Host` values `localhost`, `127.0.0.1` and `[::1]` (any port); set `ALLOWED_HOSTS` (comma-separated hostnames) to allow more. `POST /api/sync` also rejects browser requests whose `Origin` or `Sec-Fetch-Site` is not same-origin; non-browser clients such as `curl` send neither header and are accepted, so loopback binding is the real access control.

## Workouts

`/workouts` lists workouts and templates (duplicate, delete, save as template, use template); `/workouts/new` and `/workouts/<id>/edit` open the builder. A workout has steps (warmup, work, recovery, cooldown), repeat groups (no nesting) and one target type for the whole workout (heart rate zone, pace range or power) and, for power, one unit (watts or % FTP) with a value range per step. The form shows validation issues and the intervals.icu text preview live; the server re-validates every save. Saving a workout sends nothing anywhere; publishing happens from the calendar (see below).

API (same-origin, Host-guarded; mutations also reject cross-origin requests): `GET|POST /api/workouts` (`?templates=true|false`), `GET|PUT|DELETE /api/workouts/<id>`, `POST /api/workouts/<id>/duplicate` (`?asTemplate=true`), `POST /api/workouts/<id>/use-template`, `GET /api/workouts/<id>/text` (text/plain preview). Validation errors return 422 with `issues` (path and message).

## Calendar

`/calendar` (`?view=week|month&date=YYYY-MM-DD`) shows scheduled workouts and synced activities. Schedule a workout on a date, then Retry, Reschedule or Remove it. Schedule, Retry, Reschedule and Remove publish to intervals.icu and act on your **real** account; they need `INTERVALS_API_KEY` (and `INTERVALS_ATHLETE_ID`), otherwise they fail as not configured. API: `GET|POST /api/schedule`, `PATCH|DELETE /api/schedule/<id>`, `POST /api/schedule/<id>/retry`, `PUT|DELETE /api/schedule/<id>/link`.

Planned workouts are matched to completed activities by UTC day; only running activities match. Link, No match and Unlink override the automatic match and change local data only.

## Dashboard

`/dashboard` (`?period=week|month&n=<count>&date=YYYY-MM-DD`; 4, 8 or 12 weeks, 3, 6 or 12 months; invalid values fall back to 8 weeks or 6 months ending today) is a read-only page of tables: volume per sport (activities, duration, distance), planned vs completed workouts, and week-over-week or month-over-month trend per sport. Trend figures are estimates calculated from stored activities and labelled as such; training load, training effect and HR zones from Garmin are not stored. Days are UTC, weeks run Monday to Sunday.

## Migrations

After pulling a change that adds a Prisma migration, back up the SQLite file, then run `pnpm db:migrate` before starting the app.

## Commands

| Command              | Purpose                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Next.js dev server on 127.0.0.1:3000                                                                                                                                        |
| `pnpm build`         | Production build                                                                                                                                                            |
| `pnpm start`         | Serve the production build on 127.0.0.1                                                                                                                                     |
| `pnpm lint`          | biome lint                                                                                                                                                                  |
| `pnpm typecheck`     | `next typegen` and `tsc --noEmit` (needs `DATABASE_URL`)                                                                                                                    |
| `pnpm test`          | Unit tests (vitest)                                                                                                                                                         |
| `pnpm test:coverage` | Unit tests with coverage                                                                                                                                                    |
| `pnpm verify`        | Full gate: biome, typecheck, unit tests with coverage (needs `DATABASE_URL`)                                                                                                |
| `pnpm e2e`           | Playwright specs (smoke, workouts, calendar, dashboard) on a throwaway `e2e.db`; never clicks Sync or publishing buttons (run `pnpm exec playwright install chromium` once) |
| `pnpm format`        | biome format --write                                                                                                                                                        |
| `pnpm db:migrate`    | `prisma migrate deploy` using `DATABASE_URL` from `.env`                                                                                                                    |

## Environment variables

| Name                      | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`            | Required, SQLite file, starts with `file:`                           |
| `INTERVALS_API_KEY`       | Optional, intervals.icu API key; needed to publish from the calendar |
| `GARMIN_PERSONAL_API_KEY` | Optional, Garmin personal API key                                    |
| `ALLOWED_HOSTS`           | Optional, extra allowed hostnames, comma-separated                   |
| `INTERVALS_ATHLETE_ID`    | Optional, intervals.icu athlete id, defaults to `0`                  |
| `NODE_ENV`                | `development`, `test` or `production`, defaults to `development`     |

## Known limitations

- No authentication; loopback only.
- Schedule, Retry, Reschedule and Remove publish to your real intervals.icu account immediately, with no confirmation step.
- Only heart-rate targets and repeats are verified end to end on a watch. Pace, power, distance and padded-time workout text is accepted by intervals.icu, but the pace order (slow-fast vs fast-slow) and how pace steps render on the watch are unverified; a forum report says pace-range steps may not reach Garmin watches.
- Retry of an already published event only moves its date; name, text and target are not refreshed.
- Publishing looks the event up by external id over a window of about 366 days back and 731 ahead, and is not atomic; events dated outside that window are not found, and how the list endpoint behaves with very many events is unverified. A reschedule that succeeds remotely but fails locally leaves the two out of step until Retry. Events created by older versions before that lookup was added may be duplicated on the intervals.icu calendar; check the `wristplan-` external id prefix before deleting anything.
- Planned vs completed matching is by UTC day and only running activities match.
- Dashboard trends are estimates; Garmin training load, HR zones and training effect are not stored.
- How far back the Garmin Personal API returns history is unverified; one account returned nothing before a given date.
- FIT files are stored as blobs in the SQLite file.
- "Today" is the server's local day, while activity days are UTC.

## Contributing

`pnpm install` installs git hooks (lefthook) that run gitleaks and biome on commit: install gitleaks or the commit hook fails. `pnpm verify` is the gate and needs `DATABASE_URL`. `pnpm exec playwright install chromium` is only needed for `pnpm e2e`. Use Conventional Commits and open a pull request against `main`; see AGENTS.md.

## Security

- Secrets live only in environment variables and are read server-side at runtime.
- Never commit `.env` or any key, token or personal activity data.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

MIT, see [LICENSE](LICENSE).
