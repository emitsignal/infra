### Cron

Schedules live in the `JOBS` table in `scripts/cron.ts` and are registered with
`Bun.cron` (Bun 1.4+), which writes the crontab entries for you:

```bash
bun run cron:list       # print schedules and next fire times — changes nothing
bun run cron:install    # register every job (safe to re-run)
bun run cron:remove     # unregister every job
```

| Job                         | Schedule       | What it does                                      |
| --------------------------- | -------------- | ------------------------------------------------- |
| `emitsignal-monitor-alert`  | `*/30 * * * *` | Threshold check; silent unless something breaches |
| `emitsignal-monitor-digest` | `0 8 * * *`    | Daily snapshot, published even when healthy       |
| `emitsignal-db-backup`      | `0 3 * * *`    | Nightly database backup to R2                     |

Run the install as the user whose crontab it belongs to — root on the VPS, since
the monitor needs the Docker socket. Verify with `crontab -l`; Bun's entries are
marked `# bun-cron: <title>`. Re-registering a title replaces its entry instead
of duplicating it, so `cron:install` is idempotent.

`cron:install` refuses to run anywhere but Linux unless you pass `--force`: on
macOS `Bun.cron` installs launchd agents into `~/Library/LaunchAgents`, which is
not what you want from a dev machine. `cron:list` is always safe.

Three things to know:

- **The bun binary path is baked into the crontab entry at registration time.**
  If a bun upgrade moves the binary, the jobs silently stop — re-run
  `cron:install` after upgrading.
- **Hand-edits to the generated entries are lost on the next install.** The
  `JOBS` table is the source of truth.
- **Logging is done by the scripts, not by a shell redirect.** Bun owns the
  crontab line, so there is nowhere to add `>> logfile 2>&1`. Set
  `MONITOR_LOG_FILE` (and `BACKUP_LOG_FILE`) instead and the existing
  `/etc/logrotate.d/system-monitor` config keeps working unchanged.

<details>
<summary>Manual crontab entries (fallback)</summary>

`Bun.cron` OS-level registration is new in Bun 1.4. If it misbehaves, these
plain entries do the same thing:

```cron
*/30 * * * * cd /opt/emitsignal-infra && /usr/local/bin/bun scripts/system-monitor.ts >> /var/log/system-monitor.log 2>&1
0 8 * * *    cd /opt/emitsignal-infra && /usr/local/bin/bun scripts/system-monitor.ts --digest >> /var/log/system-monitor.log 2>&1
0 3 * * *    cd /opt/emitsignal-infra && /usr/local/bin/bun scripts/db-backup.ts >> /var/log/db-backup.log 2>&1
```

</details>

Thresholds and the topic come from the repository `.env` (see `.env.example`),
so nothing on the schedule side holds secrets.

# emitsignal-infra

Operational scripts for EmitSignal. All scripts run with [Bun](https://bun.sh)
and require Docker (the PostgreSQL client tools run inside a one-off
`postgres:*` container, so you don't need `pg_dump`/`pg_restore` installed
locally).

## Requirements

- Bun >= 1.3
- Docker (running)
- Access to the target PostgreSQL database and a Cloudflare R2 bucket

## Install

```bash
bun install
```

## Database backup & restore (Cloudflare R2)

Dumps the database with `pg_dump` (custom format) and stores it in an R2 bucket;
restore pulls a dump back down and applies it with `pg_restore`.

### Setup

```bash
cp .env.example .env
# then fill in your R2 credentials + bucket in .env
```

> The loader in `lib/env.ts` still reads `../../infra/.env` and
> `../../packages/emitsignal-server/.env` relative to this repository, which is a
> leftover from living inside the monorepo. Until it is adjusted, export the
> variables in your shell or place the `.env` where that loader looks.

### Backup

```bash
bun run db:backup
# or: bun scripts/db-backup.ts
```

Prints the uploaded object key, e.g. `db-backups/emitsignal-20260621-2247.dump`.

### Restore

```bash
bun run db:restore                 # restore the most recent backup
bun run db:restore -- --list       # list available backups
bun run db:restore -- <object-key> # restore a specific backup
bun run db:restore -- <key> --yes  # skip the confirmation prompt
```

Restore uses `pg_restore --clean --if-exists`, which **drops and recreates**
objects in the target database. It prompts for confirmation unless `--yes` is
passed.

### Notes

- A local `DATABASE_URL` (`localhost`/`127.0.0.1`) reaches your host database
  automatically: on Linux the one-off container runs with `--network=host`, on
  macOS it is routed through `host.docker.internal`. The Linux path matters when
  the port is published to loopback only (`127.0.0.1:5432:5432`), which is not
  reachable over the docker bridge gateway.
- Set `EMITSIGNAL_TOPIC` to publish each run's outcome back to EmitSignal —
  priority 2 on success, priority 5 on failure. Unset means no notifications.
  Publishing is best-effort: a failed notification is warned about but never
  fails the backup itself.
- Keep `POSTGRES_IMAGE` in sync with your database's major version.
- Credentials are passed to the container via `PG*` env vars (not on the command
  line), so they don't leak into `docker`'s process arguments.

## System monitor

Snapshots host health (memory, CPU, disk, load, uptime) plus the Docker
containers whose name starts with `MONITOR_CONTAINER_PREFIX` (default
`emitsignal-`, so the Dokploy control plane is left out), and publishes the
result to the EmitSignal topic in `EMITSIGNAL_TOPIC`.

```bash
bun run monitor            # publish only if a threshold is crossed (exit 1)
bun run monitor:digest     # always publish a snapshot (exit 0 when healthy)
bun scripts/system-monitor.ts --dry-run   # print the report, publish nothing
```

A plain run stays silent while everything is healthy — it is meant for a
frequent cron entry. The digest run is the once-a-day "here are the numbers"
signal. Every run prints the full report to stdout, so redirecting to a log file
replaces what the old `system-monitor.sh` logged itself.

Alerts (priority 5) are raised when host memory, CPU or disk crosses its
threshold, when a container passes `MONITOR_CONTAINER_MEM_THRESHOLD` **of its own
memory limit**, or when a container is not running, is unhealthy, or has
restarted more than `MONITOR_RESTART_THRESHOLD` times. A digest with no alerts is
priority 2.

### Cron

```cron
*/30 * * * * cd /opt/emitsignal-infra && /usr/local/bin/bun scripts/system-monitor.ts >> /var/log/system-monitor.log 2>&1
0 8 * * *    cd /opt/emitsignal-infra && /usr/local/bin/bun scripts/system-monitor.ts --digest >> /var/log/system-monitor.log 2>&1
```

Thresholds and the topic come from the repository `.env` (see `.env.example`),
so the crontab holds no secrets. Log rotation, if you want it, is unchanged from
before — `/etc/logrotate.d/system-monitor` with `weekly`, `rotate 8`, `compress`.

### Notes

- Host metrics read `/proc`, which is Linux-only. On macOS those lines report as
  unavailable and the rest of the report still renders — useful for developing
  the format, not for real numbers.
- Docker being unreachable is not fatal: the host section still publishes and
  the body says which Docker metrics were missing.
- Containers without a `--memory` limit are excluded from the memory-pressure
  ranking. Docker measures those against total host RAM, so their "memory %"
  says nothing about how close they are to being killed.
- This supersedes the standalone `system-monitor.sh` and its `ES_HOST` /
  `ES_TOPIC` / `ES_API_KEY` variables; the Bun script uses `EMITSIGNAL_*` like
  the backup scripts do.

## Development

```bash
bun run lint         # ESLint
bun run lint:fix     # ESLint with auto-fix
bun run format       # Prettier (run before every commit)
bun run format:check # Prettier check only
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`<prefix>: <description>` (`feat`, `fix`, `refactor`, `chore`, `docs`, …).

## Code style

- 4-space indent, single quotes, semicolons, 100-column width (Prettier)
- TypeScript strict mode; no `any`
- No abbreviations in identifiers
- File names in kebab-case

## License

[MIT](LICENSE)
