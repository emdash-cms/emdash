---
"emdash": minor
"@emdash-cms/cloudflare": patch
---

Fixes scheduled entries going live up to a minute after their scheduled time.

On Cloudflare, each Cron Trigger run waits up to 70 seconds for upcoming entries and publishes each one at its scheduled time, so an entry scheduled about a minute or more ahead no longer depends on when the next trigger starts. Waiting uses no CPU time, but while entries are scheduled within that window a scheduled invocation stays open for up to about a minute, so consecutive invocations can overlap in Workers logs and metrics. Sites that use `createScheduledHandler()` from `@emdash-cms/cloudflare/worker` get this automatically.

On Node.js, the scheduler runs the publishing sweep at the start of every minute, so an entry scheduled for a whole minute, as the admin sets it, goes live at that minute. A schedule with seconds, which only the API and MCP can set, can still go live up to a minute late.

A scheduled publish that another scheduler run or an editor has already completed no longer runs `content:beforePublish` hooks, so a hook cannot record a rejection for an entry that is already live.

A custom Worker entry point that calls `runScheduledTasks()` from `emdash/middleware` publishes only entries that are already due. To wait for upcoming entries, pass the new `publishUpcomingWithinMs` option:

```ts title="src/worker.ts"
await runScheduledTasks({ publishUpcomingWithinMs: 70 * 1000 });
```
