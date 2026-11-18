# wristplan

Plan workouts and sync them to your watch. A Next.js app that integrates intervals.icu and Garmin Connect.

Works with Garmin Connect; not affiliated with Garmin.

## Requirements

- Node 22 (see `.nvmrc`)
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

## Commands

| Command       | Purpose                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm verify` | Full gate: biome, typecheck, unit tests with coverage                                             |
| `pnpm test`   | Unit tests (vitest)                                                                               |
| `pnpm e2e`    | Playwright smoke tests on a throwaway `e2e.db` (run `pnpm exec playwright install chromium` once) |

## Environment variables

| Name                      | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `DATABASE_URL`            | Required, SQLite file, starts with `file:`         |
| `INTERVALS_API_KEY`       | Optional, intervals.icu API key                    |
| `GARMIN_PERSONAL_API_KEY` | Optional, Garmin personal API key                  |
| `ALLOWED_HOSTS`           | Optional, extra allowed hostnames, comma-separated |
| `INTERVALS_ATHLETE_ID`    | intervals.icu athlete id, defaults to `0`          |
| `NODE_ENV`                | `development`, `test` or `production`              |

## Security

- Secrets live only in environment variables and are read server-side at runtime.
- Never commit `.env` or any key, token or personal activity data.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

MIT, see [LICENSE](LICENSE).
