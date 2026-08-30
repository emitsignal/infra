/**
 * Host metrics for the system monitor.
 *
 * Memory, CPU, load and uptime come straight from `/proc`, which only exists on
 * Linux — the VPS these scripts run on. A reader that cannot find its source
 * throws a `SystemMetricError` naming the file, so a macOS dev run fails with an
 * explanation instead of an opaque ENOENT, and the caller can degrade to
 * "unavailable" for that single metric.
 *
 * Disk usage goes through `df -Pk` (POSIX) rather than `df --output=pcent`,
 * which is a GNU coreutils extension.
 */

import { cpus, totalmem } from 'node:os';

export interface CpuUsage {
    /** Cores on the host — the percentage is already averaged across all of them. */
    coreCount: number;
    percentUsed: number;
}

export interface DiskUsage {
    availableBytes: number;
    mount: string;
    percentUsed: number;
    totalBytes: number;
    usedBytes: number;
}

export interface LoadAverage {
    coreCount: number;
    fifteenMinutes: number;
    fiveMinutes: number;
    oneMinute: number;
    /** 1-minute load expressed as a percentage of the available cores. */
    percentOfCores: number;
}

export interface MemoryUsage {
    availableBytes: number;
    percentUsed: number;
    totalBytes: number;
    usedBytes: number;
}

export class SystemMetricError extends Error {
    constructor(metric: string, source: string, cause?: unknown) {
        super(
            `Could not read ${metric} from ${source}` +
                (process.platform === 'linux' ? '' : ` (only available on Linux)`),
            { cause },
        );

        this.name = 'SystemMetricError';
    }
}

// A tick is 1/100th of a core-second, so a one-second window on a 2-core box is
// only ~200 ticks: a single short-lived process running alongside the sample can
// own most of it and read as a host-wide spike. Three seconds costs nothing on a
// half-hourly cron and makes the number stable.
const CPU_SAMPLE_INTERVAL_MILLISECONDS = 3_000;

export function hostCoreCount(): number {
    return Math.max(cpus().length, 1);
}

export function hostTotalMemoryBytes(): number {
    return totalmem();
}

/**
 * Busy time over total time between two `/proc/stat` samples — the same
 * definition as `100 - idle%`, but measured over an interval instead of since
 * boot (which would only ever report a long-run average).
 *
 * This reads the *whole host*, so whatever else the caller is doing lands in the
 * number. Callers must not run other work — spawning `docker stats` especially —
 * while this is awaited; see `collectSnapshot` in scripts/system-monitor.ts.
 */
export async function readCpu(): Promise<CpuUsage> {
    const first = await readCpuSample();

    await Bun.sleep(CPU_SAMPLE_INTERVAL_MILLISECONDS);

    const second = await readCpuSample();

    const busy = second.busy - first.busy;
    const total = second.total - first.total;

    return {
        coreCount: hostCoreCount(),
        percentUsed: total > 0 ? (busy / total) * 100 : 0,
    };
}

export async function readDisk(mount: string): Promise<DiskUsage> {
    const proc = Bun.spawn(['df', '-Pk', mount], { stderr: 'pipe', stdout: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new SystemMetricError('disk usage', `df -Pk ${mount}`, stderr.trim());
    }

    const lines = stdout.trim().split('\n');
    // -P guarantees one line per filesystem, so the last line is the mount we asked for.
    const fields = lines[lines.length - 1]?.trim().split(/\s+/) ?? [];

    if (fields.length < 5) {
        throw new SystemMetricError('disk usage', `df -Pk ${mount}`);
    }

    const totalBytes = Number(fields[1]) * 1024;
    const usedBytes = Number(fields[2]) * 1024;
    const availableBytes = Number(fields[3]) * 1024;

    if (!Number.isFinite(totalBytes) || totalBytes === 0) {
        throw new SystemMetricError('disk usage', `df -Pk ${mount}`);
    }

    return {
        availableBytes,
        mount,
        percentUsed: (usedBytes / totalBytes) * 100,
        totalBytes,
        usedBytes,
    };
}

export async function readLoadAverage(): Promise<LoadAverage> {
    const contents = await readProc('/proc/loadavg', 'load average');
    const [oneMinute = NaN, fiveMinutes = NaN, fifteenMinutes = NaN] = contents
        .trim()
        .split(/\s+/)
        .map(Number);

    if (!Number.isFinite(oneMinute)) {
        throw new SystemMetricError('load average', '/proc/loadavg');
    }

    const coreCount = hostCoreCount();

    return {
        coreCount,
        fifteenMinutes,
        fiveMinutes,
        oneMinute,
        percentOfCores: (oneMinute / coreCount) * 100,
    };
}

/**
 * "Used" is total minus *available* (not minus free): page cache is reclaimable,
 * so counting it as used would report a healthy Linux box as permanently full.
 */
export async function readMemory(): Promise<MemoryUsage> {
    const contents = await readProc('/proc/meminfo', 'memory usage');
    const totalKilobytes = matchMeminfo(contents, 'MemTotal');
    const availableKilobytes = matchMeminfo(contents, 'MemAvailable');

    if (totalKilobytes === null || availableKilobytes === null || totalKilobytes === 0) {
        throw new SystemMetricError('memory usage', '/proc/meminfo');
    }

    const totalBytes = totalKilobytes * 1024;
    const availableBytes = availableKilobytes * 1024;

    return {
        availableBytes,
        percentUsed: ((totalBytes - availableBytes) / totalBytes) * 100,
        totalBytes,
        usedBytes: totalBytes - availableBytes,
    };
}

export async function readUptimeSeconds(): Promise<number> {
    const contents = await readProc('/proc/uptime', 'uptime');
    const seconds = Number(contents.trim().split(/\s+/)[0]);

    if (!Number.isFinite(seconds)) {
        throw new SystemMetricError('uptime', '/proc/uptime');
    }

    return seconds;
}

function matchMeminfo(contents: string, key: string): null | number {
    const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(contents);

    return match === null ? null : Number(match[1]);
}

async function readCpuSample(): Promise<{ busy: number; total: number }> {
    const contents = await readProc('/proc/stat', 'CPU usage');
    const line = contents.split('\n')[0] ?? '';
    const [label, ...values] = line.trim().split(/\s+/);

    if (label !== 'cpu') {
        throw new SystemMetricError('CPU usage', '/proc/stat');
    }

    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0] =
        values.map(Number);

    const busy = user + nice + system + irq + softirq;

    return { busy, total: busy + idle + iowait };
}

async function readProc(path: string, metric: string): Promise<string> {
    try {
        return await Bun.file(path).text();
    } catch (error) {
        throw new SystemMetricError(metric, path, error);
    }
}
