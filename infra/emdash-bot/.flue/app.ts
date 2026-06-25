// Worker entry.
//
// Public surface:
//   GET  /health           liveness probe
//   POST /webhook/github   GitHub App webhook ingress (signature-verified)
//   /workflows/<name>      Flue's standard workflow invoke routes (mounted via flue())
//
// The webhook handler is intentionally thin: it verifies, normalizes, and
// dispatches to the per-issue OrchestratorDO. All long-running work happens
// inside the DO (and the workflows it invokes), not in this handler -- GitHub
// expects an ack within ~10s.
//
// Core routes live in `routes.ts` so the workers-pool test entry can mount
// just those without pulling in Flue's routing.

import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { registerCoreRoutes } from "./routes.js";

const app = new Hono<{ Bindings: Env }>();
registerCoreRoutes(app);

// Mount Flue's standard routes (workflow invoke, run inspection) AFTER core
// routes. Tests don't mount this.
app.route("/", flue());

export default app;
