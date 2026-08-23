#!/usr/bin/env bun
/**
 * Dump the PostgreSQL database (custom format) and upload it to Cloudflare R2.
 *
 *   bun scripts/db-backup.ts
 *
 * The dump is written to a local temp file, streamed up to R2 under
 * BACKUP_PREFIX, then removed. The object key is printed on success — pass it to
 * db-restore.ts to roll back.
 */

import { unlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BackupConfig } from '../lib/config';

import { createR2Client, loadConfig } from '../lib/config';
import { formatBytes } from '../lib/format';
import { appendLog } from '../lib/log';
import { publishSignal } from '../lib/notify';
import { dumpDatabase } from '../lib/postgres';

/**
 * Exported so the cron target in scripts/cron/ can run a backup without going
 * through the CLI. Never calls process.exit — that is the CLI's business.
 */
export async function runBackupJob(): Promise<void> {
    const config = await loadConfig();

    try {
        await runBackup(config);

        await appendLog(config.logFile, 'Backup complete.');
    } catch (error) {
        await appendLog(
            config.logFile,
            `Backup FAILED: ${error instanceof Error ? error.message : String(error)}`,
        );

        await publishSignal(config.notify, {
            body: `${error instanceof Error ? error.message : String(error)}\nhost: ${hostname()}`,
            priority: 5,
            tags: ['database', 'backup', 'failed'],
            title: '❌ Database backup failed',
        });

        throw error;
    }
}

async function runBackup(config: BackupConfig): Promise<void> {
    const databaseName = new URL(config.databaseUrl).pathname.replace(/^\//, '') || 'database';
    const objectKey = `${config.prefix}/${databaseName}-${timestamp()}.dump`;
    const localPath = join(tmpdir(), `emitsignal-backup-${timestamp()}.dump`);

    console.log(`📦 Dumping "${databaseName}" via ${config.postgresImage}…`);

    await dumpDatabase({
        databaseUrl: config.databaseUrl,
        outputPath: localPath,
        postgresImage: config.postgresImage,
    });

    const dumpFile = Bun.file(localPath);
    const size = dumpFile.size;

    if (size === 0) {
        await unlink(localPath).catch(() => {});
        throw new Error('Dump is empty — aborting upload.');
    }

    console.log(`⬆️  Uploading ${formatBytes(size)} to r2://${config.bucket}/${objectKey}…`);

    const client = createR2Client(config);

    await client.file(objectKey).write(dumpFile, { type: 'application/octet-stream' });

    await unlink(localPath).catch(() => {});

    console.log('✅ Backup complete.');
    console.log(`   key: ${objectKey}`);
    console.log(`   restore with: bun scripts/db-restore.ts ${objectKey}`);

    await publishSignal(config.notify, {
        body:
            `${databaseName} · ${formatBytes(size)}\n` +
            `r2://${config.bucket}/${objectKey}\n` +
            `host: ${hostname()}`,
        priority: 2,
        tags: ['database', 'backup'],
        title: '✅ Database backup complete',
    });
}

function timestamp(): string {
    const now = new Date();
    const pad = (value: number) => value.toString().padStart(2, '0');

    return (
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    );
}

// Only when run directly — importing this module must not start a backup.
if (import.meta.main) {
    try {
        await runBackupJob();
    } catch (error) {
        console.error(
            `❌ Backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    }
}
