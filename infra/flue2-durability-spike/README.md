# Flue 2 durability spike

Isolated production experiment for Flue 2's accepted-work contract with a Cloudflare Sandbox. It does not share state or classes with the deployed emdashbot.

The pinned nightly packages were published on 17 July 2026. Until the workspace's 24-hour package cooldown expires, add `--config.minimumReleaseAge=0` to `pnpm` invocations for this package.

## Setup

```sh
pnpm wrangler secret put PROBE_KEY
pnpm deploy
```

Use the deployed Worker URL and the same `PROBE_KEY` locally:

```sh
PROBE_KEY=... pnpm exec tsx scripts/probe.ts https://emdash-flue2-durability-spike.<subdomain>.workers.dev quick
PROBE_KEY=... pnpm exec tsx scripts/probe.ts https://emdash-flue2-durability-spike.<subdomain>.workers.dev long container
PROBE_KEY=... pnpm exec tsx scripts/probe.ts https://emdash-flue2-durability-spike.<subdomain>.workers.dev long container-abort
PROBE_KEY=... pnpm exec tsx scripts/probe.ts https://emdash-flue2-durability-spike.<subdomain>.workers.dev durable-long container
```

For an agent Durable Object reset, start a long probe in one terminal and redeploy the identical build from another:

```sh
PROBE_KEY=... pnpm exec tsx scripts/probe.ts https://emdash-flue2-durability-spike.<subdomain>.workers.dev long redeploy
pnpm deploy
```

Each admitted run must print exactly one `submission_settled` event and finish with a history containing that settlement. A failed settlement is acceptable after retry exhaustion; a timeout or missing settlement is not.

## Results from 17 July 2026

| Scenario                                                               | Result                                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal Sandbox command                                                 | Settled `completed`; live event and history agreed.                                                                                                              |
| Destroy container during ordinary tool, no host deadline               | Remained unsettled for more than 12 minutes. Neither the 180-second command timeout nor the agent's 10-minute durability timeout preempted the hung Sandbox RPC. |
| Durable abort after container destruction, no host deadline            | Abort intent was recorded, but the submission remained unsettled for more than 12 minutes while the Sandbox RPC stayed hung.                                     |
| Redeploy after ordinary tool hung                                      | Agent DO recovery marked the tool outcome unknown and settled `failed` because the durability timeout had elapsed.                                               |
| Redeploy after recorded abort                                          | Agent DO recovery marked the tool outcome unknown and settled `aborted`.                                                                                         |
| Redeploy after `durable: true` tool hung                               | Recovery re-entered the same tool call, reran the unresolved `step.do()`, created a fresh Sandbox, completed the command, and settled `completed`.               |
| Destroy container with 120-second host deadline                        | Settled exactly once without redeploy after 2m14s. The tool recorded `output-error`; the model reported that error and the submission settled `completed`.       |
| Record abort after container destruction with 120-second host deadline | Settled exactly once as `aborted` without redeploy after 2m07s.                                                                                                  |

Flue 2 recovery works after an agent DO restart, including durable tool continuation. Bounded adapter calls also let it recover autonomously without resetting the DO: the adapter deadline releases the agent fiber, after which Flue can process tool failure or stored abort intent. A production integration needs host-side deadlines around every Sandbox RPC and an external watchdog that records abort intent for stale submissions. Tool errors returned to the model may still produce a `completed` submission, so callers must not treat that settlement alone as proof that the requested task succeeded.

Upstream tracking: [withastro/flue#497](https://github.com/withastro/flue/issues/497).
