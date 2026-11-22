# wristplan

Reads your activities from Garmin and builds workouts to schedule on intervals.icu. A Next.js app. Implemented now: activity sync from Garmin (Personal API), the workout builder, scheduling and publishing workouts to intervals.icu, and a week/month calendar comparing planned and completed workouts.

Works with Garmin Connect; not affiliated with Garmin.

## Requirements

- Node >=22.13 (see `.nvmrc`)
- pnpm

## Setup

```sh
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev
```

`pnpm db:migrate` (`prisma migrate deploy`) creates the local SQLite file from `DATABASE_URL` (loaded from `.env`; fails if it is missing). Relative `file:` paths resolve from the repo root; `pnpm install` generates the Prisma client. The app is served at http://127.0.0.1:3000.

## Syncing activities

Open http://127.0.0.1:3000 and press **Sync now** to import Garmin activities into the local database. Requires `GARMIN_PERSONAL_API_KEY`; without it the sync endpoint (`POST /api/sync`) answers 503. The page lists stored activities and offers the FIT file download where one was fetched.

wristplan is a single-user app with no authentication. `pnpm dev` and `pnpm start` bind to `127.0.0.1` only; do not expose it to a network or the internet. As a defence against DNS rebinding, the sync and FIT endpoints and the home page accept only `Host` values `localhost`, `127.0.0.1` and `[::1]` (any port); set `ALLOWED_HOSTS` (comma-separated hostnames) to allow more. `POST /api/sync` also rejects browser requests whose `Origin` or `Sec-Fetch-Site` is not same-origin; non-browser clients such as `curl` send neither header and are accepted, so loopback binding is the real access control.

## Workouts

`/workouts` lists workouts and templates (duplicate, delete, save as template, use template); `/workouts/new` and `/workouts/<id>/edit` open the builder. A workout has steps (warmup, work, recovery, cooldown), repeat groups (no nesting) and one target type for the whole workout (heart rate zone, pace range or power) and, for power, one unit (watts or % FTP) with a value range per step. The form shows validation issues and the intervals.icu text preview live; the server re-validates every save. Saving a workout sends nothing anywhere; publishing happens from the calendar (see below).

API (same-origin, Host-guarded; mutations also reject cross-origin requests): `GET|POST /api/workouts` (`?templates=true|false`), `GET|PUT|DELETE /api/workouts/<id>`, `POST /api/workouts/<id>/duplicate` (`?asTemplate=true`), `POST /api/workouts/<id>/use-template`, `GET /api/workouts/<id>/text` (text/plain preview). Validation errors return 422 with `issues` (path and message).

## Calendar

`/calendar` (`?view=week|month&date=YYYY-MM-DD`) shows scheduled workouts and synced activities. Schedule a workout on a date, then Retry, Reschedule or Remove it. Schedule, Retry, Reschedule and Remove publish to intervals.icu and act on your **real** account; they need `INTERVALS_API_KEY` (and `INTERVALS_ATHLETE_ID`), otherwise they fail as not configured. API: `GET|POST /api/schedule`, `PATCH|DELETE /api/schedule/<id>`, `POST /api/schedule/<id>/retry`, `PUT|DELETE /api/schedule/<id>/link`.

Planned workouts are matched to completed activities by UTC day; only running activities match. Link, No match and Unlink override the automatic match and change local data only.

After pulling a change that adds a Prisma migration, back up the SQLite file and run `pnpm db:migrate` before starting the app.

## Commands

| Command              | Purpose                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Next.js dev server on 127.0.0.1:3000                                                                                                                             |
| `pnpm build`         | Production build                                                                                                                                                 |
| `pnpm start`         | Serve the production build on 127.0.0.1                                                                                                                          |
| `pnpm lint`          | biome lint                                                                                                                                                       |
| `pnpm typecheck`     | `next typegen` and `tsc --noEmit` (needs `DATABASE_URL`)                                                                                                         |
| `pnpm test`          | Unit tests (vitest)                                                                                                                                              |
| `pnpm test:coverage` | Unit tests with coverage                                                                                                                                         |
| `pnpm verify`        | Full gate: biome, typecheck, unit tests with coverage (needs `DATABASE_URL`)                                                                                     |
| `pnpm e2e`           | Playwright specs (smoke, workouts, calendar) on a throwaway `e2e.db`; never clicks Sync or publishing buttons (run `pnpm exec playwright install chromium` once) |
| `pnpm format`        | biome format --write                                                                                                                                             |
| `pnpm db:migrate`    | `prisma migrate deploy` using `DATABASE_URL` from `.env`                                                                                                         |

## Environment variables

| Name                      | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`            | Required, SQLite file, starts with `file:`                           |
| `INTERVALS_API_KEY`       | Optional, intervals.icu API key; needed to publish from the calendar |
| `GARMIN_PERSONAL_API_KEY` | Optional, Garmin personal API key                                    |
| `ALLOWED_HOSTS`           | Optional, extra allowed hostnames, comma-separated                   |
| `INTERVALS_ATHLETE_ID`    | Optional, intervals.icu athlete id, defaults to `0`                  |
| `NODE_ENV`                | `development`, `test` or `production`, defaults to `development`     |

## Security

- Secrets live only in environment variables and are read server-side at runtime.
- Never commit `.env` or any key, token or personal activity data.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

MIT, see [LICENSE](LICENSE).
