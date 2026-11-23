# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-23

### Release notes

First public pre-release. wristplan reads Garmin data only (Garmin Personal API, read-only). It is self-hosted, local, single-user and has no authentication. Schedule, Retry, Reschedule and Remove act immediately on your real intervals.icu account, with no confirmation step.

### Upgrade notes

If you ran an earlier build from `main`: back up the SQLite file, then run `pnpm db:migrate`. It applies the pending migrations, including `20261122180000_schedule_activity_link`, which adds two nullable columns and a unique index to `ScheduledWorkout` and drops nothing. Events created by earlier builds, before publishing looked events up by external id, may be duplicated on the intervals.icu calendar; check the `wristplan-` external id prefix before deleting anything.

### Added

- Activities: sync from the Garmin Personal API, idempotent import into the local SQLite database, FIT file download, activity list on the home page.
- Workouts: builder (warmup, work, recovery, cooldown steps and non-nested repeat groups), server-side validation, templates (duplicate, save as template, use template), intervals.icu workout text serialisation with live preview, REST API.
- Scheduling and publishing: publish workouts to intervals.icu with status `pending`, `published` or `failed`; retry, reschedule and remove; publishing is idempotent through a lookup by external id; an ownership guard means only events with a `wristplan-` external id are modified or deleted.
- Calendar: week and month views of scheduled workouts and synced activities; planned workouts matched to completed running activities by UTC day; manual Link, No match and Unlink, stored locally only.
- Dashboard: read-only tables of weekly or monthly volume per sport, planned vs completed workouts and estimated trends.
- Security and hardening: loopback-only bind, Host allow-list (extendable with `ALLOWED_HOSTS`), same-origin guard on mutating requests (Origin and Sec-Fetch-Site), secrets redacted from errors and logs (covered by a test), environment validation that never echoes values, dependency audit and secret scan in CI, `effect` pinned to 3.22.5 through a package override.

### Known limitations

See [README.md](README.md#known-limitations) for the full list. In short: no authentication; real-account publishing without confirmation; only heart-rate targets and repeats are verified end to end on a watch (pace, power, distance and padded-time text is unverified on the watch); Retry of a published event only moves its date; the publish lookup covers about 366 days back and 731 ahead and is not atomic; matching is by UTC day and running only; dashboard trends are estimates; Garmin history depth is unverified; FIT files are stored in the SQLite file; "today" is the server's local day while activity days are UTC.

[0.1.0]: https://github.com/rciesielski3/wristplan/releases
