/**
 * Appends a run's output to a log file.
 *
 * `Bun.cron` writes the crontab line itself, so there is nowhere to add
 * `>> /var/log/system-monitor.log 2>&1` — and hand-editing the generated entry
 * would be lost on the next install. Writing the log from inside the script
 * keeps file logging working no matter how the job was launched.
 *
 * Logging is best-effort, like notifications: an unwritable path is warned about
 * but never turns a successful run into a failed one.
 */

import { appendFile } from 'node:fs/promises';

export async function appendLog(path: null | string, text: string): Promise<void> {
    if (path === null) {
        return;
    }

    try {
        await appendFile(path, `\n===== ${new Date().toISOString()} =====\n${text}\n`);
    } catch (error) {
        console.warn(
            `⚠️  Could not write to ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
