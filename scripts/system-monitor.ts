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
 * Every run prints the full report to stdout, so redirecting the cron entry to a
 * log file reproduces what the old system-monitor.sh wrote itself.
 */

import { hostname } from 'node:os';

import type { MonitorConfig } from '../lib/config';
import type { MonitorSnapshot } from '../lib/report';

import { loadMonitorConfig } from '../lib/config';
import { readContainerHealth, readContainerStats, readDockerDiskUsage } from '../lib/docker';
import { publishSignal } from '../lib/notify';
import { collectWarnings, formatReport, formatTitle } from '../lib/report';
import { readCpu, readDisk, readLoadAverage, readMemory, readUptimeSeconds } from '../lib/system';

const ALERT_PRIORITY = 5;
const DIGEST_PRIORITY = 2;

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

    // Collected in parallel: the CPU reader alone costs a one-second sample, and
    // one unavailable metric must not sink the rest of the report.
    const [
        memory,
        cpu,
        disk,
        load,
        uptimeSeconds,
        containerStats,
        containerHealth,
        dockerDiskUsage,
    ] = await Promise.all([
        attempt('memory', () => readMemory()),
        attempt('cpu', () => readCpu()),
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

async function main(): Promise<void> {
    const config = await loadMonitorConfig();
    const isDigest = process.argv.includes('--digest');
    const isDryRun = process.argv.includes('--dry-run');

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

    if (isDryRun) {
        console.log(`\n(dry run — ${warnings.length} warning(s), nothing published)`);

        return;
    }

    if (warnings.length === 0 && !isDigest) {
        return;
    }

    await publishSignal(config.notify, {
        body: report,
        priority: warnings.length > 0 ? ALERT_PRIORITY : DIGEST_PRIORITY,
        tags:
            warnings.length > 0 ? ['system', 'monitor', 'alert'] : ['system', 'monitor', 'digest'],
        title: formatTitle(snapshot, warnings),
    });

    if (warnings.length > 0) {
        process.exit(1);
    }
}

main().catch((error) => {
    console.error(`❌ System monitor failed: ${describe(error)}`);
    process.exit(1);
});
