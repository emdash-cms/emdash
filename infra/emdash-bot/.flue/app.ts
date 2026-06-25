// Worker entry. For the Phase 0 spike, the only public route is `flue()` —
// Flue's built-in routing that exposes discovered workflows at
// /workflows/<name>. That lets us `client.workflows.invoke('classify-command')`
// and `client.workflows.invoke('investigate')` from local dev and the eval
// harness without any custom webhook handler yet.
//
// Phase 3 adds the /webhook/github route + the Orchestrator DO.

import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.text("ok"));

// Mount Flue's standard routes (workflow invoke, run inspection).
app.route("/", flue());

export default app;
