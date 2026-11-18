# wristplan

TypeScript (ESM, Node >=22, pnpm) app integrating intervals.icu and Garmin. Code lives in `src/modules/`; so far only the intervals.icu client.

## Commands

- `pnpm verify` — full gate: `biome check .`, `tsc --noEmit`, vitest with coverage. Must pass before every commit.
- `pnpm test` / `pnpm test:coverage` — vitest (`src/**/*.test.ts`, `test/**/*.test.ts`).
- `pnpm format` — biome format --write.
- `pnpm lint` / `pnpm typecheck`.

## Layout

- `src/modules/**` — one folder per module. Coverage threshold: 90% lines and branches.
- `src/modules/intervals` — intervals.icu HTTP client (client, config, errors); `fetch` is injectable for tests. I/O clients live under `modules/<integration>` while there is one integration; extract adapters to `src/integrations/` once more exist.
- `src/modules/garmin` — Garmin Personal API read client (client, config, errors, zip): token exchange with JWT cache, activity list, FIT download; `fetch` and `now` injectable. Retry/backoff is left to the sync service.
- `src/lib/**` — shared code; `lib/env` validates environment variables with zod (`parseEnv`, `getEnv`); `lib/db` is the Prisma + SQLite client (`createDb`, `getDb`; schema in `prisma/`, generated client in gitignored `src/generated/`). Same 90% threshold.
- `test/` — contract and cross-module tests.
- `src/modules/activities` — Garmin→SQLite activity sync service (`syncActivities`): paged, idempotent upserts, FIT stored once, run log in `SyncRun`; Garmin client, db, `now` and `sleep` injected. Also `handleSync`/`handleFitDownload` (HTTP handlers with origin guard, deps injected), list queries and formatters; `src/app` holds only thin Next wrappers (`POST /api/sync`, `GET /api/activities/[id]/fit`, home page, `SyncButton`).
- Commit scopes mirror modules: activities, workouts, calendar, analytics, intervals, garmin, lib, repo, ci, deps.

## Conventions

- TypeScript strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`, no non-null assertions without a reason.
- Keep domain logic separated from I/O; I/O is confined to integration clients with injectable transport.
- Relative imports are extensionless (Turbopack cannot map .js to .ts).
- Tests: deterministic, no real network or time, synthetic fixtures only (no real activity data, GPS, IDs, tokens). Live tests only with `LIVE_TESTS=1`. Use fake, low-entropy test credentials (gitleaks flags high-entropy fakes). Tests exercise the default-deny ownership guard (`allowForeign` only in bypass tests); shared helpers live in `test/`. Never lower coverage thresholds or weaken assertions.
- Comments only for a non-obvious "why".
- Smallest change that meets the AC. DRY, KISS, YAGNI. Justify every new dependency in the commit body.
- Dependencies are pinned to exact versions (no `^`).

## Safety

- Never read `.env`; secrets are read at runtime only. Never log or print them.
- Never invent API endpoints or payloads; verify against official docs.
- Anything that modifies real intervals.icu or Garmin data needs explicit confirmation.
- Ownership: workouts created by the app carry `external_id` starting with `wristplan-`. Reschedule of events without it always throws `IntervalsForeignEventError`; delete throws it unless `allowForeign: true` is passed. Never pass `allowForeign` without explicit user confirmation.

## Git

- Conventional Commits, `type(scope): subject`, imperative, lowercase, <=72 chars. Types: feat, fix, refactor, perf, test, build, ci, chore, revert.
- No AI attribution or `Co-Authored-By`. Never change git config. Never push without asking.
- `main` is protected: PR required, checks `verify` and `conventional-title`, branch up to date, squash-only, linear history. Flow: branch -> PR -> review by an agent other than the author -> squash merge only if the reviewer says safe. Pushing a branch, opening a PR, `gh pr update-branch` and merging each need user approval unless the user has authorized the PR flow for the current task.
- If merge is blocked as BEHIND: `gh pr update-branch <n> --rebase`, wait for CI, then merge. Confirm the merge landed (`gh pr view`, `git log`) before reporting it.
- commitlint body lines <=100 chars.
- Node 22 required (`.nvmrc`, `engine-strict=true`): `source ~/.nvm/nvm.sh && nvm use 22`.
- Hooks (lefthook): gitleaks + biome on commit, commitlint on message, `pnpm verify` on push.
- `CLAUDE.md`, `AGENTS.md` and `.claude/` (agents, settings) are tracked. Never commit `.ai/`, `.claude/settings.local.json`, plans, notes or ADRs.
