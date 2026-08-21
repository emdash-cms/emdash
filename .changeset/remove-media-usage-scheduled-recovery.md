---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Removes scheduled Media Usage recovery APIs. Media Usage now starts when an administrator enables it and continues through the Cloudflare Queue or Node.js scheduler. This is a breaking change for Cloudflare deployments that configure `mediaUsageCron` and Node.js integrations that provide a custom `CronScheduler`.

#### What should I do?

On Cloudflare, remove the dedicated Media Usage Cron and the `mediaUsageCron` option. Configure `createMediaUsageFetchHandler()` and `createMediaUsageQueueHandler()` to start and continue indexing.

If you provide a custom Node.js scheduler, replace `setMediaUsageMaintenance()` with `setContinuousMediaUsageMaintenance()` and `wakeMediaUsageMaintenance()`. Keep the Queue consumer or Node.js process running until Media Usage shows **Ready**; the general Cron no longer restarts interrupted indexing.
