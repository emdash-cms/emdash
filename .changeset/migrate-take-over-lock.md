---
"emdash": minor
---

Adds `emdash migrate --take-over-lock <id>`, which applies pending migrations under a stuck D1 migration lock without freeing it first. Releasing the lock with `--release-lock` and then running `emdash migrate` let a Worker in `auto` mode take the free lock in between, and the apply failed with a lock error.

```sh
pnpm emdash migrate --take-over-lock 1788264000000
```

Like `--release-lock`, it asks you to confirm the target, or needs `--expected-target-fingerprint` in a non-interactive shell.
