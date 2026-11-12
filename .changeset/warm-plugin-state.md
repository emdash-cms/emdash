---
"emdash": patch
---

Fixes plugin enable, disable, install, update, and uninstall changes leaving other warm Cloudflare Workers on an outdated plugin set until redeployment. Workers now check persisted plugin state at five-second intervals before handling requests or scheduled tasks, updating routes and hooks without replaying installation or activation hooks. Changes can still take up to five seconds to be detected by a warm worker, plus database replication delay when read replicas are enabled. Installing or updating a plugin also waits for its bundle to load.

If a worker cannot read plugin state, it rejects requests until a subsequent check succeeds rather than running plugins against stale state. Failed checks and bundle loads are retried at the next five-second interval.
