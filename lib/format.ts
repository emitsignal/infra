/**
 * Small formatting helpers shared by the infra scripts.
 *
 * Docker reports sizes as human strings ("226.4MiB", "1.022GiB", "35.6MB"), so
 * anything we want to compare or rank has to be parsed back into bytes first.
 * Docker mixes the two conventions on purpose: memory is binary (MiB/GiB) while
 * network and block I/O are decimal (kB/MB), and `parseByteSize` honours both.
 */

const BYTE_UNITS: Record<string, number> = {
    b: 1,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
};

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
}

export function formatPercent(value: number): string {
    return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

/** Parses a Docker size string ("226.4MiB", "35.6MB", "0B") into bytes. */
export function parseByteSize(value: string): null | number {
    const match = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(value);

    if (match === null) {
        return null;
    }

    const amount = Number(match[1]);
    const unit = BYTE_UNITS[(match[2] ?? '').toLowerCase() || 'b'];

    if (!Number.isFinite(amount) || unit === undefined) {
        return null;
    }

    return amount * unit;
}

/** Parses a Docker percentage string ("88.42%") into a number. */
export function parsePercent(value: string): null | number {
    const parsed = Number(value.replace('%', '').trim());

    return Number.isFinite(parsed) ? parsed : null;
}
