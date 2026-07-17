import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono, type MiddlewareHandler } from "hono";

import { DurabilityProbe } from "./agents/durability-probe.js";

interface Bindings {
	PROBE_KEY: string;
	Sandbox: DurableObjectNamespace<Sandbox>;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ ok: true, runtime: "flue2" }));

const requireProbeKey: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
	if (!c.env.PROBE_KEY || c.req.header("authorization") !== `Bearer ${c.env.PROBE_KEY}`) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	await next();
};

app.use("/control/*", requireProbeKey);
app.use("/agents/*", requireProbeKey);

app.post("/control/:id/container/destroy", async (c) => {
	const sandbox = getSandbox(c.env.Sandbox, c.req.param("id"));
	await Promise.race([
		sandbox.destroy(),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Sandbox destroy timed out after 30 seconds")), 30_000),
		),
	]);
	return c.json({ destroyed: true });
});

app.route("/agents/durability-probe", createAgentRouter(DurabilityProbe));

export default app;
