# wristplan

TypeScript (ESM, Node >=22, pnpm) app integrating intervals.icu and Garmin. No code in `src/` yet; tooling is bootstrapped.

## Commands

- `pnpm verify` — full gate: `biome check .`, `tsc --noEmit`, vitest with coverage. Must pass before every commit.
- `pnpm test` / `pnpm test:coverage` — vitest (`src/**/*.test.ts`, `test/**/*.test.ts`).
- `pnpm format` — biome format --write.
- `pnpm lint` / `pnpm typecheck`.

## Layout

- `src/modules/**` — domain logic (pure). Coverage threshold: 90% lines and branches.
- `src/integrations/` — I/O adapters behind interfaces.
- `test/` — contract and cross-module tests.
- Commit scopes mirror modules: activities, workouts, calendar, analytics, intervals, garmin, lib, repo, ci, deps.

## Conventions

- TypeScript strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `any`, no non-null assertions without a reason.
- Domain logic separated from I/O.
- Tests: deterministic, no real network or time, synthetic fixtures only (no real activity data, GPS, IDs, tokens). Live tests only with `LIVE_TESTS=1`. Never lower coverage thresholds or weaken assertions.
- Comments only for a non-obvious "why".
- Smallest change that meets the AC. DRY, KISS, YAGNI. Justify every new dependency in the commit body.
- Dependencies are pinned to exact versions (no `^`).

## Safety

- Never read `.env`; secrets are read at runtime only. Never log or print them.
- Never invent API endpoints or payloads; verify against official docs.
- Anything that modifies real intervals.icu or Garmin data needs explicit confirmation.

## Git

- Conventional Commits, `type(scope): subject`, imperative, lowercase, <=72 chars. Types: feat, fix, refactor, perf, test, build, ci, chore, revert.
- No AI attribution or `Co-Authored-By`. Never change git config. Never push without asking.
- Hooks (lefthook): gitleaks + biome on commit, commitlint on message, `pnpm verify` on push.
- `CLAUDE.md`, `AGENTS.md` and `.claude/` (agents, settings) are tracked. Never commit `.ai/`, `.claude/settings.local.json`, plans, notes or ADRs.
