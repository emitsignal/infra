/**
 * Typed configuration for the infra scripts.
 *
 * Reuses the same `S3_*` credentials the server uses for Cloudflare R2 (see
 * `packages/emitsignal-server/src/lib/storage/s3-provider.ts`). Backups land in
 * `BACKUP_BUCKET` (defaults to the private bucket) under `BACKUP_PREFIX`.
 *
 * Setting `EMITSIGNAL_TOPIC` opts in to publishing run outcomes back to
 * EmitSignal itself; leaving it unset disables notifications entirely.
 *
 * The system monitor has its own loader: it needs the notification settings but
 * none of the database or R2 credentials, so requiring them would make the
 * monitor unusable on a host that only runs Docker.
 */

import { loadEnvironment } from './env';

export interface BackupConfig {
    bucket: string;
    databaseUrl: string;
    notify: NotifyConfig;
    postgresImage: string;
    prefix: string;
    r2: R2Credentials;
}

export interface MonitorConfig {
    containerPrefix: string;
    diskMount: string;
    notify: NotifyConfig;
    thresholds: MonitorThresholds;
}

export interface MonitorThresholds {
    /** Percentage of a container's own memory limit. */
    containerMemoryPercent: number;
    cpuPercent: number;
    diskPercent: number;
    memoryPercent: number;
    /** A container that restarted more often than this is considered unstable. */
    restartCount: number;
}

export interface NotifyConfig {
    apiKey: null | string;
    apiUrl: string;
    topic: null | string;
}

export interface R2Credentials {
    accessKeyId: string;
    endpoint: string;
    region: string;
    secretAccessKey: string;
}

export function createR2Client(config: BackupConfig, bucket?: string): Bun.S3Client {
    return new Bun.S3Client({
        accessKeyId: config.r2.accessKeyId,
        bucket: bucket ?? config.bucket,
        endpoint: config.r2.endpoint,
        region: config.r2.region,
        secretAccessKey: config.r2.secretAccessKey,
    });
}

export async function loadConfig(): Promise<BackupConfig> {
    await loadEnvironment();

    const r2: R2Credentials = {
        accessKeyId: required('S3_ACCESS_KEY_ID'),
        endpoint: required('S3_ENDPOINT'),
        // R2 ignores the region but the S3 protocol requires one; "auto" is the R2 convention.
        region: optional('S3_REGION', 'auto'),
        secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    };

    return {
        bucket: optional('BACKUP_BUCKET', required('S3_PRIVATE_BUCKET_NAME')),
        databaseUrl: required('DATABASE_URL'),
        notify: loadNotifyConfig(),
        postgresImage: optional('POSTGRES_IMAGE', 'postgres:16-alpine'),
        prefix: optional('BACKUP_PREFIX', 'db-backups').replace(/\/+$/, ''),
        r2,
    };
}

export async function loadMonitorConfig(): Promise<MonitorConfig> {
    await loadEnvironment();

    return {
        containerPrefix: optional('MONITOR_CONTAINER_PREFIX', 'emitsignal-'),
        diskMount: optional('MONITOR_DISK_MOUNT', '/'),
        notify: loadNotifyConfig(),
        thresholds: {
            containerMemoryPercent: percentage('MONITOR_CONTAINER_MEM_THRESHOLD', 90),
            cpuPercent: percentage('MONITOR_CPU_THRESHOLD', 85),
            diskPercent: percentage('MONITOR_DISK_THRESHOLD', 85),
            memoryPercent: percentage('MONITOR_MEM_THRESHOLD', 85),
            restartCount: integer('MONITOR_RESTART_THRESHOLD', 3),
        },
    };
}

function integer(name: string, fallback: number): number {
    const value = process.env[name];

    if (value === undefined || value.trim() === '') {
        return fallback;
    }

    const parsed = Number(value.trim());

    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Environment variable "${name}" must be a non-negative number.`);
    }

    return parsed;
}

function loadNotifyConfig(): NotifyConfig {
    return {
        apiKey: nullable('EMITSIGNAL_API_KEY'),
        apiUrl: optional('EMITSIGNAL_API_URL', 'https://api.emitsignal.com').replace(/\/+$/, ''),
        topic: nullable('EMITSIGNAL_TOPIC'),
    };
}

function nullable(name: string): null | string {
    const value = process.env[name];

    return value === undefined || value.trim() === '' ? null : value.trim();
}

function optional(name: string, fallback: string): string {
    const value = process.env[name];

    return value === undefined || value.trim() === '' ? fallback : value;
}

function percentage(name: string, fallback: number): number {
    const parsed = integer(name, fallback);

    if (parsed > 100) {
        throw new Error(`Environment variable "${name}" must be a percentage between 0 and 100.`);
    }

    return parsed;
}

function required(name: string): string {
    const value = process.env[name];

    if (value === undefined || value.trim() === '') {
        throw new Error(
            `Missing required environment variable "${name}". Set it in infra/.env (copy infra/.env.example).`,
        );
    }

    return value;
}
