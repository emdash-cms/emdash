---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Removes scheduled Media Usage recovery APIs. Setup and historical indexing now advance while an administrator keeps **Settings → Media Usage** open. This is a breaking change for Cloudflare deployments that configure `mediaUsageCron` and Node.js integrations that provide a custom `CronScheduler`.

#### What should I do?

On Cloudflare, remove the dedicated Media Usage Cron and the `mediaUsageCron` option. Keep the general Cron unchanged; Media Usage needs no Queue or replacement scheduled handler.

If you provide a custom Node.js scheduler, remove `setMediaUsageMaintenance()`. A custom `CronScheduler` now implements only `start()`, `stop()`, `reschedule()`, and `setSystemCleanup()`.

Keep the Media Usage Settings page open until it shows **Ready**. If the page closes, return to continue from stored progress.
