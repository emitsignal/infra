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
# or: bun db-backup.ts
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

- A local `DATABASE_URL` (`localhost`/`127.0.0.1`) is automatically routed to
  `host.docker.internal` so the one-off container reaches your host database.
- Keep `POSTGRES_IMAGE` in sync with your database's major version.
- Credentials are passed to the container via `PG*` env vars (not on the command
  line), so they don't leak into `docker`'s process arguments.

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
