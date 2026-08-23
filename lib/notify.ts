/**
 * Publishes backup/restore outcomes to an EmitSignal topic, so unattended runs
 * (crontab) surface somewhere other than a log file nobody reads.
 *
 * Notifications are best-effort by design: publishing is disabled when
 * EMITSIGNAL_TOPIC is unset, and a publish that fails is warned about but never
 * turns a successful backup into a failed one.
 */

import type { NotifyConfig } from './config';

const PUBLISH_TIMEOUT_MILLISECONDS = 10_000;

export interface SignalMessage {
    body: string;
    priority: number;
    tags: string[];
    title: string;
}

export async function publishSignal(config: NotifyConfig, message: SignalMessage): Promise<void> {
    if (config.topic === null) {
        return console.warn('Skipping publishSignal - topic name not configured');
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (config.apiKey !== null) {
        headers.authorization = `Bearer ${config.apiKey}`;
    }

    try {
        const response = await fetch(
            `${config.apiUrl}/publish/${encodeURIComponent(config.topic)}`,
            {
                body: JSON.stringify(message),
                headers,
                method: 'POST',
                // Without a deadline a hung API would keep a cron run alive forever.
                signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MILLISECONDS),
            },
        );

        if (!response.ok) {
            console.warn(
                `⚠️  EmitSignal notification failed: HTTP ${response.status} ${response.statusText}`,
            );
        }

        console.info(`EmitSignal notification delivered: ${config.topic}`);
    } catch (error) {
        console.warn(
            `⚠️  EmitSignal notification failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
