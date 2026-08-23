/**
 * Cron target: the frequent threshold check.
 *
 * A separate module from scripts/system-monitor.ts because that one script has
 * two schedules — this frequent check and the daily digest — and `scheduled()`
 * receives no job title to branch on (only the schedule string), so the variant
 * has to be encoded in the module Bun registers.
 *
 * Bun runs a registered job by importing it and calling `scheduled()`, so
 * `import.meta.main` is false in everything this pulls in: system-monitor.ts's
 * CLI block stays dormant and the run happens exactly once.
 *
 * Deliberately does not exit non-zero when a threshold is crossed: the
 * EmitSignal alert is the signal, and a failing exit code in cron mode only adds
 * noise to the system log. A genuine crash still throws.
 */

import { runMonitor } from '../system-monitor';

export default {
    async scheduled(): Promise<void> {
        await runMonitor({ digest: false });
    },
};
