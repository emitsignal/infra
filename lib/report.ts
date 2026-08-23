/**
 * Turns a metrics snapshot into warnings and into the body published to
 * EmitSignal.
 *
 * The body is a UTF-8 JSON field (see `lib/notify.ts`), so emoji and box drawing
 * survive the round trip — unlike the header-based publish the previous shell
 * script used, where Latin-1 header values mangled anything non-ASCII.
 */

import type { MonitorThresholds } from './config';
import type { ContainerHealth, ContainerStat, DockerDiskUsageEntry } from './docker';
import type { CpuUsage, DiskUsage, LoadAverage, MemoryUsage } from './system';

import { formatBytes, formatDuration, formatPercent } from './format';

export interface MonitorSnapshot {
    containerHealth: ContainerHealth[] | null;
    containerPrefix: string;
    containerStats: ContainerStat[] | null;
    cpu: CpuUsage | null;
    disk: DiskUsage | null;
    dockerDiskUsage: DockerDiskUsageEntry[] | null;
    /** Metrics that could not be collected; reported in the body, never fatal. */
    errors: string[];
    hostname: string;
    load: LoadAverage | null;
    memory: MemoryUsage | null;
    uptimeSeconds: null | number;
}

export interface Warning {
    detail: string;
    label: string;
}

const SEPARATOR = '──────────────────────';

export function collectWarnings(
    snapshot: MonitorSnapshot,
    thresholds: MonitorThresholds,
): Warning[] {
    const warnings: Warning[] = [];

    if (snapshot.memory !== null && snapshot.memory.percentUsed >= thresholds.memoryPercent) {
        warnings.push({
            detail: `${formatPercent(snapshot.memory.percentUsed)} used (limit ${thresholds.memoryPercent}%)`,
            label: 'memory',
        });
    }

    if (snapshot.cpu !== null && snapshot.cpu.percentUsed >= thresholds.cpuPercent) {
        warnings.push({
            detail: `${formatPercent(snapshot.cpu.percentUsed)} busy (limit ${thresholds.cpuPercent}%)`,
            label: 'cpu',
        });
    }

    if (snapshot.disk !== null && snapshot.disk.percentUsed >= thresholds.diskPercent) {
        warnings.push({
            detail: `${formatPercent(snapshot.disk.percentUsed)} of ${snapshot.disk.mount} used, ${formatBytes(snapshot.disk.availableBytes)} free`,
            label: 'disk',
        });
    }

    // Reported under the same short names the container table uses.
    const short = shortenNames([
        ...(snapshot.containerStats ?? []).map((container) => container.name),
        ...(snapshot.containerHealth ?? []).map((container) => container.name),
    ]);

    for (const container of snapshot.containerStats ?? []) {
        if (
            container.memoryPercent !== null &&
            container.memoryPercent >= thresholds.containerMemoryPercent
        ) {
            warnings.push({
                detail: `${formatPercent(container.memoryPercent)} of its ${formatBytes(container.memoryLimitBytes ?? 0)} limit`,
                label: short.get(container.name) ?? container.name,
            });
        }
    }

    for (const container of snapshot.containerHealth ?? []) {
        if (container.state !== 'running') {
            // A `restart: no` container that exited 0 is a finished job, not an
            // outage: the compose stack runs `prisma migrate deploy` that way,
            // and the server and worker only start once it succeeds. A *service*
            // that exited is still an alert even on code 0 — it should be up.
            if (isCompletedJob(container)) {
                continue;
            }

            warnings.push({
                detail:
                    container.state === 'exited'
                        ? `exited with code ${container.exitCode}`
                        : `is ${container.state}`,
                label: short.get(container.name) ?? container.name,
            });

            continue;
        }

        if (container.health === 'unhealthy') {
            warnings.push({
                detail: 'healthcheck is failing',
                label: short.get(container.name) ?? container.name,
            });
        }

        if (container.restartCount > thresholds.restartCount) {
            warnings.push({
                detail: `restarted ${container.restartCount} times (limit ${thresholds.restartCount})`,
                label: short.get(container.name) ?? container.name,
            });
        }
    }

    return warnings;
}

export function formatReport(
    snapshot: MonitorSnapshot,
    warnings: Warning[],
    thresholds: MonitorThresholds,
): string {
    const sections: string[] = [formatHeader(snapshot), formatHostMetrics(snapshot, thresholds)];

    const containers = formatContainers(snapshot, thresholds);

    if (containers !== null) {
        sections.push(containers);
    }

    const dockerDisk = formatDockerDiskUsage(snapshot);

    if (dockerDisk !== null) {
        sections.push(dockerDisk);
    }

    if (warnings.length > 0) {
        sections.push(
            [
                '🚨 Alerts',
                ...warnings.map((warning) => `   ${warning.label}: ${warning.detail}`),
            ].join('\n'),
        );
    }

    if (snapshot.errors.length > 0) {
        sections.push(
            ['⚠️  Unavailable', ...snapshot.errors.map((error) => `   ${error}`)].join('\n'),
        );
    }

    sections.push(`${SEPARATOR}\n🕒 ${formatTimestamp(new Date())}`);

    return sections.join('\n\n');
}

export function formatTitle(snapshot: MonitorSnapshot, warnings: Warning[]): string {
    if (warnings.length === 0) {
        return `✅ ${snapshot.hostname} — all systems healthy`;
    }

    return `🚨 ${snapshot.hostname} — ${warnings.length} ${warnings.length === 1 ? 'alert' : 'alerts'}`;
}

/** A one-shot job (`restart: no`) that ran to completion. */
export function isCompletedJob(container: ContainerHealth): boolean {
    return (
        container.state === 'exited' && container.exitCode === 0 && container.restartPolicy === 'no'
    );
}

function formatContainers(snapshot: MonitorSnapshot, thresholds: MonitorThresholds): null | string {
    const stats = snapshot.containerStats;

    if (stats === null) {
        return null;
    }

    if (stats.length === 0) {
        return `📦 Containers\n   none matching "${snapshot.containerPrefix}"`;
    }

    // Includes health-only entries (an exited job is absent from `docker stats`)
    // so their names shorten against the same shared prefix as the table rows.
    const short = shortenNames([
        ...stats.map((container) => container.name),
        ...(snapshot.containerHealth ?? []).map((container) => container.name),
    ]);
    const width = Math.max(...stats.map((container) => (short.get(container.name) ?? '').length));
    const healthByName = new Map(
        (snapshot.containerHealth ?? []).map((container) => [container.name, container]),
    );

    // Ranked by memory pressure so whatever is closest to its limit reads first.
    const ranked = [...stats].sort((a, b) => (b.memoryPercent ?? -1) - (a.memoryPercent ?? -1));

    const rows = ranked.map((container) => {
        const health = healthByName.get(container.name);
        const memory =
            container.memoryPercent === null
                ? '   —'
                : `${Math.round(container.memoryPercent).toString().padStart(3)}%`;
        const icon =
            container.memoryPercent !== null &&
            container.memoryPercent >= thresholds.containerMemoryPercent
                ? '⚠️'
                : health?.health === 'unhealthy' || (health && health.state !== 'running')
                  ? '❌'
                  : '✅';
        const limit =
            container.memoryLimitBytes === null
                ? 'no limit'
                : formatBytes(container.memoryLimitBytes);

        return (
            `   ${(short.get(container.name) ?? container.name).padEnd(width)}  ` +
            `${formatPercent(container.cpuPercent).padStart(6)} cpu  ` +
            `${formatBytes(container.memoryUsageBytes).padStart(9)} / ${limit.padEnd(8)} ` +
            `${memory} ${icon}`
        );
    });

    const restarts = (snapshot.containerHealth ?? [])
        .filter((container) => container.restartCount > 0)
        .map(
            (container) =>
                `${short.get(container.name) ?? container.name} ×${container.restartCount}`,
        );

    if (restarts.length > 0) {
        rows.push(`   ↻ restarts: ${restarts.join(', ')}`);
    }

    // Jobs are absent from `docker stats` once they exit, so without this they
    // would vanish from the report entirely rather than reading as "done".
    const completed = (snapshot.containerHealth ?? [])
        .filter((container) => isCompletedJob(container))
        .map((container) => short.get(container.name) ?? container.name);

    if (completed.length > 0) {
        rows.push(`   ✔ completed: ${completed.join(', ')}`);
    }

    return [`📦 Containers (${stats.length})`, ...rows].join('\n');
}

function formatDockerDiskUsage(snapshot: MonitorSnapshot): null | string {
    const entries = snapshot.dockerDiskUsage;

    if (entries === null || entries.length === 0) {
        return null;
    }

    const width = Math.max(...entries.map((entry) => entry.type.length));

    return [
        '🗄️  Docker disk',
        ...entries.map(
            (entry) =>
                `   ${entry.type.padEnd(width)}  ${entry.size.padStart(9)}  ` +
                `${entry.active}/${entry.total} active  ${entry.reclaimable} reclaimable`,
        ),
    ].join('\n');
}

function formatHeader(snapshot: MonitorSnapshot): string {
    const parts: string[] = [];

    if (snapshot.uptimeSeconds !== null) {
        parts.push(`up ${formatDuration(snapshot.uptimeSeconds)}`);
    }

    if (snapshot.load !== null) {
        parts.push(
            `load ${snapshot.load.oneMinute.toFixed(2)} / ${snapshot.load.fiveMinutes.toFixed(2)} / ` +
                `${snapshot.load.fifteenMinutes.toFixed(2)} ` +
                `(${formatPercent(snapshot.load.percentOfCores)} of ${snapshot.load.coreCount} cores)`,
        );
    }

    const header = `🖥️  ${snapshot.hostname}`;

    return parts.length === 0 ? header : `${header}\n⏱️  ${parts.join(' · ')}`;
}

function formatHostMetrics(snapshot: MonitorSnapshot, thresholds: MonitorThresholds): string {
    const lines: string[] = [];

    if (snapshot.memory !== null) {
        lines.push(
            metricLine('🧠', 'Memory', snapshot.memory.percentUsed, thresholds.memoryPercent, [
                `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`,
            ]),
        );
    }

    if (snapshot.cpu !== null) {
        lines.push(metricLine('⚙️', 'CPU', snapshot.cpu.percentUsed, thresholds.cpuPercent, []));
    }

    if (snapshot.disk !== null) {
        lines.push(
            metricLine(
                '💾',
                `Disk (${snapshot.disk.mount})`,
                snapshot.disk.percentUsed,
                thresholds.diskPercent,
                [`${formatBytes(snapshot.disk.availableBytes)} free`],
            ),
        );
    }

    return lines.length === 0 ? '⚠️  No host metrics available' : lines.join('\n');
}

function formatTimestamp(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, '0');

    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
    );
}

function metricLine(
    icon: string,
    label: string,
    value: number,
    threshold: number,
    extras: string[],
): string {
    const breached = value >= threshold;
    const status = breached ? `⚠️  limit ${threshold}%` : '✅';
    const suffix = extras.length === 0 ? '' : `  ${extras.join(' · ')}`;

    return `${icon} ${label.padEnd(14)} ${`${Math.round(value)}%`.padStart(4)}  ${status}${suffix}`;
}

/**
 * Compose names carry the whole deployment prefix
 * (`emitsignal-production-server-ioyucv-worker-1`). Stripping the prefix shared
 * by every reported container, plus the replica suffix, leaves the service name
 * — and because only a *shared* prefix is removed, names stay unambiguous.
 */
function shortenNames(names: string[]): Map<string, string> {
    const segments = names.map((name) => name.split('-'));
    const first = segments[0] ?? [];
    let shared = 0;

    while (
        segments.length > 1 &&
        shared < first.length - 1 &&
        segments.every((parts) => parts[shared] === first[shared])
    ) {
        shared += 1;
    }

    return new Map(
        names.map((name, index) => {
            const parts = (segments[index] ?? []).slice(shared);
            const last = parts[parts.length - 1];

            // Drop the compose replica index ("-1"), but never the whole name.
            if (parts.length > 1 && last !== undefined && /^\d+$/.test(last)) {
                parts.pop();
            }

            return [name, parts.join('-') || name];
        }),
    );
}
