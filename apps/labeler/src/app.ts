import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { requireAccessVerification } from "./access.js";
import { createProductionListingLabelIssuer } from "./assessment/runtime.js";
import { queryLabels } from "./labels/index.js";
import { handleOperatorApi } from "./operator/api.js";
import { handlePublicAssessmentXrpc } from "./public-assessment.js";
import {
	labelerDidDocument,
	labelerHandleDocument,
	labelerPolicyDocument,
} from "./public-service.js";
import { createRuntimeListingLabelSigner } from "./runtime-signer.js";
import { subscribeLabels } from "./subscriptions/index.js";

const app = new Hono<{ Bindings: Env }>();

const publicCors = cors({
	origin: "*",
	allowMethods: ["GET", "HEAD", "OPTIONS"],
});

app.use("/.well-known/*", publicCors);
app.use("/health", publicCors);
app.use("/xrpc/*", publicCors);

app.get("/.well-known/did.json", (context) => labelerDidDocument(context.env));
app.get("/.well-known/atproto-did", (context) => labelerHandleDocument(context.env));
app.get("/.well-known/emdash-labeler-policy.json", (context) => labelerPolicyDocument(context.env));

app.all("/xrpc/com.atproto.label.queryLabels", (context) =>
	queryLabels(context.env.DB, context.req.raw, () => createRuntimeListingLabelSigner(context.env)),
);
app.all("/xrpc/com.atproto.label.subscribeLabels", (context) =>
	subscribeLabels(context.env.LABEL_SUBSCRIPTION_DO, context.req.raw),
);
app.all("/xrpc/*", async (context) => {
	return (await handlePublicAssessmentXrpc(context.req.raw, context.env)) ?? context.notFound();
});

app.on(["GET", "HEAD"], "/health", async (context) => {
	const [discovery, signing] = await Promise.all([
		context.env.LABELER_DISCOVERY_DO.getByName("main").status(),
		createProductionListingLabelIssuer(context.env).then(
			() => ({ ready: true as const }),
			() => ({ ready: false as const, reason: "signing-configuration-invalid" as const }),
		),
	]);
	const ready = discovery.ready && signing.ready;
	const status = ready ? 200 : 503;
	if (context.req.method === "HEAD") {
		return context.body(null, status, {
			"cache-control": "no-store",
			"content-type": "application/json",
		});
	}
	return context.json(
		{
			service: "emdash-labeler",
			status: ready ? "ok" : "not-ready",
			discovery,
			signing,
		},
		status,
		{ "cache-control": "no-store" },
	);
});
app.all("/health", (context) => context.body(null, 405, { allow: "GET, HEAD" }));

app.all("/_admin/api/*", (context) => handleOperatorApi(context.req.raw, context.env));
app.all("/_admin", adminShell);
app.all("/_admin/*", adminShell);

app.notFound((context) => context.text("not found", 404));

async function adminShell(context: Context<{ Bindings: Env }>): Promise<Response> {
	const verification = await requireAccessVerification(context.req.raw, context.env);
	if (!verification.ok) return verification;
	return context.env.ASSETS.fetch(
		new Request(new URL("/index.html", context.req.url), context.req.raw),
	);
}

export default app;
