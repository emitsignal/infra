#!/usr/bin/env bun
/**
 * Snapshot host and Docker health, and publish it to an EmitSignal topic.
 *
 *   bun scripts/system-monitor.ts            # publish only when a threshold is crossed
 *   bun scripts/system-monitor.ts --digest   # always publish (daily digest)
 *   bun scripts/system-monitor.ts --dry-run  # print the report, publish nothing
 *
 * A plain run is meant for a frequent cron entry: it stays silent while the box
 * is healthy and publishes a priority-5 alert (exiting 1, so cron's MAILTO also
 * fires) the moment memory, CPU, disk, a container's memory limit, or a
 * container's health crosses its threshold. The digest run is the once-a-day
 * "everything is fine, here are the numbers" signal.
 *
 * Every run prints the full report to stdout, and appends it to MONITOR_LOG_FILE
 * when that is set.
 *
 * `runMonitor` is exported so the cron target in scripts/cron/ can call it
 * without going through the CLI. It deliberately never calls process.exit: the
 * exit code is the CLI's business, not the scheduled job's.
 */

import { hostname } from 'node:os';

import type { MonitorConfig } from '../lib/config';
import type { MonitorSnapshot } from '../lib/report';

import { loadMonitorConfig } from '../lib/config';
import { readContainerHealth, readContainerStats, readDockerDiskUsage } from '../lib/docker';
import { appendLog } from '../lib/log';
import { publishSignal } from '../lib/notify';
import { collectWarnings, formatReport, formatTitle } from '../lib/report';
import { readCpu, readDisk, readLoadAverage, readMemory, readUptimeSeconds } from '../lib/system';

const ALERT_PRIORITY = 5;
const DIGEST_PRIORITY = 2;

export interface MonitorRunOptions {
    digest?: boolean;
    dryRun?: boolean;
}

export interface MonitorRunResult {
    warningCount: number;
}

export async function runMonitor({
    digest = false,
    dryRun = false,
}: MonitorRunOptions = {}): Promise<MonitorRunResult> {
    const config = await loadMonitorConfig();

    let snapshot: MonitorSnapshot;

    try {
        snapshot = await collectSnapshot(config);
    } catch (error) {
        await publishSignal(config.notify, {
            body: `${describe(error)}\nhost: ${hostname()}`,
            priority: ALERT_PRIORITY,
            tags: ['system', 'monitor', 'failed'],
            title: `❌ ${hostname()} — system monitor failed`,
        });

        throw error;
    }

    const warnings = collectWarnings(snapshot, config.thresholds);
    const report = formatReport(snapshot, warnings, config.thresholds);

    console.log(report);

    if (dryRun) {
        console.log(`\n(dry run — ${warnings.length} warning(s), nothing published)`);

        return { warningCount: warnings.length };
    }

    await appendLog(config.logFile, report);

    if (warnings.length > 0 || digest) {
        await publishSignal(config.notify, {
            body: report,
            priority: warnings.length > 0 ? ALERT_PRIORITY : DIGEST_PRIORITY,
            tags:
                warnings.length > 0
                    ? ['system', 'monitor', 'alert']
                    : ['system', 'monitor', 'digest'],
            title: formatTitle(snapshot, warnings),
        });
    }

    return { warningCount: warnings.length };
}

async function collectSnapshot(config: MonitorConfig): Promise<MonitorSnapshot> {
    const errors: string[] = [];

    const attempt = async <T>(label: string, run: () => Promise<T>): Promise<null | T> => {
        try {
            return await run();
        } catch (error) {
            errors.push(`${label}: ${describe(error)}`);

            return null;
        }
    };

    // First and alone: readCpu samples /proc/stat over a window, which measures
    // the whole host — including this process. Running it alongside the `docker`
    // and `df` subprocesses below made the monitor report its own work as a
    // host-wide spike (a ~2% idle box read as 90%+ and paged us).
    const cpu = await attempt('cpu', () => readCpu());

    // The rest are cheap enough to overlap, and one unavailable metric must not
    // sink the whole report.
    const [memory, disk, load, uptimeSeconds, containerStats, containerHealth, dockerDiskUsage] =
        await Promise.all([
            attempt('memory', () => readMemory()),
            attempt('disk', () => readDisk(config.diskMount)),
            attempt('load average', () => readLoadAverage()),
            attempt('uptime', () => readUptimeSeconds()),
            attempt('docker stats', () => readContainerStats(config.containerPrefix)),
            attempt('docker health', () => readContainerHealth(config.containerPrefix)),
            attempt('docker system df', () => readDockerDiskUsage()),
        ]);

    return {
        containerHealth,
        containerPrefix: config.containerPrefix,
        containerStats,
        cpu,
        disk,
        dockerDiskUsage,
        errors,
        hostname: hostname(),
        load,
        memory,
        uptimeSeconds,
    };
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Only when run directly — importing this module (as scripts/cron/ does) must
// not execute a monitor run as a side effect.
if (import.meta.main) {
    try {
        const { warningCount } = await runMonitor({
            digest: process.argv.includes('--digest'),
            dryRun: process.argv.includes('--dry-run'),
        });

        // Non-zero on a breach so cron's MAILTO fires for a manual/CLI run too.
        if (warningCount > 0) {
            process.exit(1);
        }
    } catch (error) {
        console.error(`❌ System monitor failed: ${describe(error)}`);
        process.exit(1);
    }
}
