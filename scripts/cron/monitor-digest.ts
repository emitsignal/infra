/**
 * Cron target: the daily digest, published even when everything is healthy.
 *
 * See scripts/cron/monitor-alert.ts for why each schedule needs its own module
 * rather than a single `scheduled()` export on the entrypoint.
 */

import { runMonitor } from '../system-monitor';

export default {
    async scheduled(): Promise<void> {
        await runMonitor({ digest: true });
    },
};
