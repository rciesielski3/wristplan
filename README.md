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
pnpm dev
```

The app is served at http://localhost:3000.

## Commands

| Command       | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `pnpm verify` | Full gate: biome, typecheck, unit tests with coverage                    |
| `pnpm test`   | Unit tests (vitest)                                                      |
| `pnpm e2e`    | Playwright smoke test (run `pnpm exec playwright install chromium` once) |

## Environment variables

| Name                      | Description                               |
| ------------------------- | ----------------------------------------- |
| `DATABASE_URL`            | Optional, must start with `file:`         |
| `INTERVALS_API_KEY`       | Optional, intervals.icu API key           |
| `GARMIN_PERSONAL_API_KEY` | Optional, Garmin personal API key         |
| `INTERVALS_ATHLETE_ID`    | intervals.icu athlete id, defaults to `0` |
| `NODE_ENV`                | `development`, `test` or `production`     |

## Security

- Secrets live only in environment variables and are read server-side at runtime.
- Never commit `.env` or any key, token or personal activity data.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

MIT, see [LICENSE](LICENSE).
