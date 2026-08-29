---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Removes scheduled media usage recovery. Media usage tracking now advances only while an administrator keeps its settings page visible. This breaks Cloudflare deployments that configure `mediaUsageCron` and Node.js integrations that provide a custom `CronScheduler`.

#### What should I do?

On Cloudflare, remove the dedicated media usage Cron Trigger and the `mediaUsageCron` option. Keep the general Cron Trigger unchanged; no replacement trigger is required.

If you provide a custom Node.js scheduler, remove `setMediaUsageMaintenance()`. A custom `CronScheduler` now implements only `start()`, `stop()`, `reschedule()`, and `setSystemCleanup()`.

Keep **Settings → Media usage tracking** open until it shows **Ready**. If the page closes, return to continue from saved progress.
