/**
 * Docker metrics for the system monitor.
 *
 * Everything comes from the CLI in JSON mode (`--format '{{json .}}'`), one
 * object per line, so we never depend on column alignment. Only containers whose
 * name starts with the configured prefix are reported: the VPS also runs the
 * Dokploy control plane, which is not ours to alert on.
 *
 * Stats and health are read independently so that a failure of one (an old
 * daemon, a container that vanished between calls) still leaves the other in the
 * report.
 */

import { parseByteSize, parsePercent } from './format';
import { hostTotalMemoryBytes } from './system';

export interface ContainerHealth {
    /** `healthy` / `unhealthy` / `starting`, or null when no healthcheck is defined. */
    health: null | string;
    name: string;
    restartCount: number;
    /** `running`, `restarting`, `exited`, … */
    state: string;
    /** Human status line from `docker ps`, e.g. "Up 4 days (healthy)". */
    status: string;
}

export interface ContainerStat {
    blockIo: string;
    cpuPercent: number;
    memoryLimitBytes: null | number;
    /** Percentage of the container's own memory limit; null when it has none. */
    memoryPercent: null | number;
    memoryUsageBytes: number;
    name: string;
    netIo: string;
    pids: number;
}

export interface DockerDiskUsageEntry {
    active: number;
    reclaimable: string;
    size: string;
    total: number;
    type: string;
}

export class DockerError extends Error {
    constructor(command: string, detail: string) {
        super(`docker ${command} failed: ${detail}`);

        this.name = 'DockerError';
    }
}

/**
 * A container without an explicit `--memory` limit is reported by Docker against
 * total host RAM, which would make its "memory %" meaningless as a pressure
 * signal. Anything within this margin of host RAM is treated as unlimited.
 */
const UNLIMITED_MEMORY_RATIO = 0.95;

export async function readContainerHealth(prefix: string): Promise<ContainerHealth[]> {
    const listed = parseJsonLines(await runDocker(['ps', '--all', '--format', '{{json .}}']));

    const names = listed
        .map((entry) => String(entry.Names ?? ''))
        .filter((name) => name.startsWith(prefix));

    if (names.length === 0) {
        return [];
    }

    const details = await readInspectDetails(names);

    return names.map((name) => {
        const entry = listed.find((candidate) => candidate.Names === name);
        const detail = details.get(name);

        return {
            health: detail?.health ?? null,
            name,
            restartCount: detail?.restartCount ?? 0,
            state: String(entry?.State ?? detail?.state ?? 'unknown'),
            status: String(entry?.Status ?? ''),
        };
    });
}

export async function readContainerStats(prefix: string): Promise<ContainerStat[]> {
    const entries = parseJsonLines(
        await runDocker(['stats', '--no-stream', '--format', '{{json .}}']),
    );
    const totalMemory = await readDockerMemoryTotal();

    return entries
        .filter((entry) => String(entry.Name ?? '').startsWith(prefix))
        .map((entry) => {
            const [usage, limit] = String(entry.MemUsage ?? '').split('/');
            const memoryUsageBytes = parseByteSize(usage ?? '') ?? 0;
            const parsedLimit = limit === undefined ? null : parseByteSize(limit);
            const isUnlimited =
                parsedLimit === null || parsedLimit >= totalMemory * UNLIMITED_MEMORY_RATIO;

            return {
                blockIo: String(entry.BlockIO ?? '—'),
                cpuPercent: parsePercent(String(entry.CPUPerc ?? '')) ?? 0,
                memoryLimitBytes: isUnlimited ? null : parsedLimit,
                memoryPercent: isUnlimited
                    ? null
                    : (parsePercent(String(entry.MemPerc ?? '')) ??
                      (memoryUsageBytes / parsedLimit) * 100),
                memoryUsageBytes,
                name: String(entry.Name),
                netIo: String(entry.NetIO ?? '—'),
                pids: Number(entry.PIDs ?? 0),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readDockerDiskUsage(): Promise<DockerDiskUsageEntry[]> {
    const entries = parseJsonLines(await runDocker(['system', 'df', '--format', '{{json .}}']));

    return entries.map((entry) => ({
        active: Number(entry.Active ?? 0),
        reclaimable: String(entry.Reclaimable ?? '—'),
        size: String(entry.Size ?? '—'),
        total: Number(entry.TotalCount ?? 0),
        type: String(entry.Type ?? 'unknown'),
    }));
}

function parseJsonLines(output: string): Record<string, unknown>[] {
    const parsed: Record<string, unknown>[] = [];

    for (const line of output.split('\n')) {
        const trimmed = line.trim();

        if (trimmed === '') {
            continue;
        }

        try {
            parsed.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
            // A daemon warning printed on stdout is not worth failing the run over.
            continue;
        }
    }

    return parsed;
}

/**
 * The memory a limitless container is measured against is the *daemon's* view of
 * host memory, which is not the machine running this script when Docker lives in
 * a VM (Docker Desktop). Falls back to local host memory if `docker info` fails.
 */
async function readDockerMemoryTotal(): Promise<number> {
    try {
        const output = await runDocker(['info', '--format', '{{.MemTotal}}']);
        const parsed = Number(output.trim());

        return Number.isFinite(parsed) && parsed > 0 ? parsed : hostTotalMemoryBytes();
    } catch {
        return hostTotalMemoryBytes();
    }
}

async function readInspectDetails(
    names: string[],
): Promise<Map<string, { health: null | string; restartCount: number; state: string }>> {
    const details = new Map<
        string,
        { health: null | string; restartCount: number; state: string }
    >();

    // Tab-separated because Go templates cannot easily emit a JSON object of
    // mixed literal and conditional fields.
    const output = await runDocker([
        'inspect',
        '--format',
        '{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}',
        ...names,
    ]);

    for (const line of output.split('\n')) {
        if (line.trim() === '') {
            continue;
        }

        const [rawName = '', restartCount, state, health] = line.split('\t');

        details.set(rawName.replace(/^\//, ''), {
            health: health === undefined || health.trim() === '' ? null : health.trim(),
            restartCount: Number(restartCount) || 0,
            state: state ?? 'unknown',
        });
    }

    return details;
}

async function runDocker(args: string[]): Promise<string> {
    const proc = Bun.spawn(['docker', ...args], {
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new DockerError(args.join(' '), stderr.trim() || `exit code ${exitCode}`);
    }

    return stdout;
}
