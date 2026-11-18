# wristplan

TypeScript (ESM, Node >=22.13, pnpm) Next.js app integrating Garmin and intervals.icu. Code lives in `src/modules/` (activities, garmin, intervals, workouts, calendar), `src/lib/` (db, env, http), `src/app/` (Next.js UI and routes), `prisma/` and `e2e/`.

## Commands

- `pnpm verify` — full gate: `biome check .`, `pnpm typecheck` (`next typegen && tsc --noEmit`), vitest with coverage. Must pass before every commit.
- `pnpm test` / `pnpm test:coverage` — vitest (`src/**/*.test.ts`, `test/**/*.test.ts`).
- `pnpm e2e` — Playwright smoke tests; builds and serves on its own port (3100) with a throwaway `e2e.db`.
- `pnpm db:migrate` — `prisma migrate deploy` using `DATABASE_URL` from `.env`.
- `pnpm dev` / `pnpm build` / `pnpm start` — Next.js; dev and start bind to 127.0.0.1.
- `pnpm format` — biome format --write. `pnpm lint` — biome lint.
- `pnpm verify`, `pnpm typecheck` and `next` need `DATABASE_URL` (CI sets `file:./ci.db`; locally it comes from `.env`).

## Layout

- `src/modules/**` — one folder per module. Coverage threshold: 90% lines and branches.
- `src/modules/intervals` — intervals.icu HTTP client (client, config, errors); `fetch` is injectable for tests. I/O clients live under `modules/<integration>` while there are few integrations; extract adapters to `src/integrations/` once more exist.
- `src/modules/garmin`, `activities`, `workouts`, `calendar` — Garmin client, activity sync/storage, workout model/builder/repository, scheduling with the intervals publisher.
- `src/lib/**` — shared code: `db`, `env` (zod, `parseEnv`, `getEnv`), `http`. Same 90% threshold.
- `src/app/**` — Next.js pages and thin route wrappers; excluded from coverage.
- `prisma/` — schema and migrations.
- `e2e/` — Playwright specs.
- `test/` — shared helpers, fakes (intervals server, publisher) and the publisher contract suite.
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
- Never start `next dev`/`next start` or call `POST /api/sync` from an agent: a populated `.env` makes it hit the real Garmin API. e2e runs on its own port/db and never clicks Sync.
- Never invent API endpoints or payloads; verify against official docs.
- Anything that modifies real intervals.icu or Garmin data needs explicit confirmation.
- Ownership: workouts created by the app carry `external_id` starting with `wristplan-`. Reschedule of events without it always throws `IntervalsForeignEventError`; delete throws it unless `allowForeign: true` is passed. Never pass `allowForeign` without explicit user confirmation.
- Workout text: only HR + repeat text is verified live (spike S1); pace, power, distance and padded times are unverified live (pace ordering slow-fast is the likeliest to be wrong).
- HTTP layers map unknown errors to a generic 500 and never echo `error.message` (repositories pass database errors through unmapped).

## Git

- Conventional Commits, `type(scope): subject`, imperative, lowercase, <=72 chars. Types: feat, fix, refactor, perf, test, build, ci, chore, revert.
- No AI attribution or `Co-Authored-By`. Never change git config. Never push without asking.
- `main` is protected: PR required, checks `verify` and `conventional-title`, branch up to date, squash-only, linear history. Flow: branch -> PR -> review by an agent other than the author -> squash merge only if the reviewer says safe. Pushing a branch, opening a PR, `gh pr update-branch` and merging each need user approval unless the user has authorized the PR flow for the current task.
- If merge is blocked as BEHIND: `gh pr update-branch <n> --rebase`, wait for CI, then merge. Confirm the merge landed (`gh pr view`, `git log`) before reporting it.
- commitlint body lines <=100 chars.
- Node 22 required (`.nvmrc`, `engine-strict=true`): `source ~/.nvm/nvm.sh && nvm use 22`.
- Hooks (lefthook): gitleaks + biome on commit, commitlint on message, `pnpm verify` on push.
- `CLAUDE.md`, `AGENTS.md` and `.claude/` (agents, settings) are tracked. Never commit `.ai/`, `.claude/settings.local.json`, plans, notes or ADRs.
