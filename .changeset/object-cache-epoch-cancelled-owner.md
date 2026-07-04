---
"emdash": patch
---

Fixes object-cache reads hanging indefinitely after a request was cancelled mid-read. A namespace epoch read started by a request that disconnects (for example a bot aborting on a 404) could leave a never-settling shared promise behind, wedging every later read of that namespace until the isolate was recycled. Waiting requests now bound the shared read with their own timer, dead reads are reclaimed after a deadline, and in-flight reads survive the originating request's cancellation where the platform allows.
