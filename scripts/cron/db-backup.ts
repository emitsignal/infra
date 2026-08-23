/**
 * Cron target: the nightly database backup.
 *
 * Kept alongside the other cron targets so every path in the scripts/cron.ts
 * JOBS table lives in one directory.
 *
 * Failures already publish a priority-5 signal from inside runBackupJob, so a
 * throw here marks the run as failed in the system log rather than delivering
 * the notification.
 */

import { runBackupJob } from '../db-backup';

export default {
    async scheduled(): Promise<void> {
        await runBackupJob();
    },
};
