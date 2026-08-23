#!/usr/bin/env bun
/**
 * Install, list, or remove this repository's scheduled jobs.
 *
 *   bun scripts/cron.ts --list      # print schedules and next fire times only
 *   bun scripts/cron.ts --install   # register every job (idempotent)
 *   bun scripts/cron.ts --remove    # unregister every job
 *
 * `Bun.cron` registers OS-level jobs — a crontab line on Linux, marked with a
 * `# bun-cron: <title>` comment. Re-registering the same title replaces the
 * entry rather than duplicating it, so --install is safe to re-run.
 *
 * The JOBS table below is the source of truth: an edit to the generated crontab
 * entry is lost on the next install.
 */

const JOBS: Job[] = [
    {
        description: 'threshold check — silent unless something breaches',
        path: './cron/monitor-alert.ts',
        schedule: '*/30 * * * *',
        title: 'emitsignal-monitor-alert',
    },
    {
        description: 'daily snapshot, published even when healthy',
        path: './cron/monitor-digest.ts',
        schedule: '0 8 * * *',
        title: 'emitsignal-monitor-digest',
    },
    {
        description: 'nightly database backup to R2',
        path: './cron/db-backup.ts',
        schedule: '0 3 * * *',
        title: 'emitsignal-db-backup',
    },
];

interface Job {
    description: string;
    path: string;
    schedule: string;
    title: string;
}

function describeSchedule(job: Job, count: number): string[] {
    const times: string[] = [];
    let cursor: Date | number = Date.now();

    for (let index = 0; index < count; index += 1) {
        const next = Bun.cron.parse(job.schedule, cursor);

        if (next === null) {
            break;
        }

        times.push(next.toLocaleString());
        cursor = next;
    }

    return times;
}

/**
 * Installing on macOS writes launchd plists into ~/Library/LaunchAgents, which
 * is never what someone wants from a dev machine. Listing is always safe.
 */
function ensureInstallable(force: boolean): void {
    if (process.platform === 'linux' || force) {
        return;
    }

    throw new Error(
        `Refusing to register jobs on ${process.platform} — these are meant for the Linux VPS.\n` +
            'Pass --force if you really want to register them on this machine.',
    );
}

async function install(force: boolean): Promise<void> {
    ensureInstallable(force);

    for (const job of JOBS) {
        await Bun.cron(job.path, job.schedule, job.title);

        const [next] = describeSchedule(job, 1);

        console.log(`✅ ${job.title}`);
        console.log(`   ${job.schedule.padEnd(14)} ${job.description}`);
        console.log(`   next: ${next ?? 'never'}`);
    }

    console.log(`\n${JOBS.length} job(s) registered. Verify with: crontab -l`);
}

function list(): void {
    for (const job of JOBS) {
        console.log(`${job.title}`);
        console.log(`   ${job.schedule.padEnd(14)} ${job.description}`);
        console.log(`   next: ${describeSchedule(job, 3).join(' · ') || 'never'}`);
    }
}

async function remove(force: boolean): Promise<void> {
    ensureInstallable(force);

    for (const job of JOBS) {
        // Removing a job that was never registered resolves without error.
        await Bun.cron.remove(job.title);

        console.log(`🗑️  ${job.title} removed`);
    }
}

const force = process.argv.includes('--force');

try {
    if (process.argv.includes('--install')) {
        await install(force);
    } else if (process.argv.includes('--remove')) {
        await remove(force);
    } else {
        list();
    }
} catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
