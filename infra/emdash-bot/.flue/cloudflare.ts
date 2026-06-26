// Cloudflare-target Durable Object exports. This file is the `main` entry in
// wrangler.jsonc so `wrangler types` can infer DO class bindings; `flue dev`
// generates its own merged config and ignores `main` here.

import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

import { mintInstallationToken, readAppCreds } from "./lib/github.js";

// Subclass so we can attach an outbound proxy to github.com. The handler runs
// in the Worker runtime (outside the sandbox) with full env access; the
// sandbox holds no credentials. The agent makes a plain HTTPS request, the
// Sandbox runtime's TLS interception decrypts it, the handler adds
// Authorization, and the request is forwarded upstream.
export class Sandbox extends BaseSandbox {
	override enableInternet = false;
	// Required: outboundByHost only sees HTTPS traffic when interception is on.
	// Defaults to false in @cloudflare/containers 0.3.x; flip it explicitly.
	override interceptHttps = true;
	override allowedHosts = [
		"github.com",
		"api.github.com",
		"codeload.github.com",
		"raw.githubusercontent.com",
		"objects.githubusercontent.com",
		"registry.npmjs.org",
		"registry.npmjs.com",
		// pkg.pr.new serves preview package builds; emdash's pnpm-lock pins
		// some deps (e.g. @lunariajs/core) there.
		"pkg.pr.new",
	];
}

// `outboundByHost` is the always-on host map; precedence is per-host > catch-
// all > none. Every github.com / api.github.com / codeload.github.com request
// from the sandbox is auth-injected here.
Sandbox.outboundByHost = {
	"github.com": authenticatedGithub,
	"api.github.com": authenticatedGithub,
	"codeload.github.com": authenticatedGithub,
};

async function authenticatedGithub(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	console.log("[sandbox/outbound] github request", {
		method: request.method,
		host: url.host,
		path: url.pathname,
	});
	const creds = readAppCreds(env);
	if (!creds) return new Response("github access not configured", { status: 403 });
	let token: string;
	try {
		token = await mintInstallationToken(creds);
	} catch (err) {
		console.error("[sandbox/outbound] token mint failed", { error: (err as Error).message });
		return new Response("token mint failed", { status: 502 });
	}
	const authed = new Request(request);
	// Basic auth works for both git smart HTTP (clone/push) and the REST API.
	// Format: x-access-token:<token>, base64-encoded.
	authed.headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
	authed.headers.set("user-agent", "emdash-bot");
	try {
		const res = await fetch(authed);
		console.log("[sandbox/outbound] github response", {
			path: url.pathname,
			status: res.status,
		});
		return res;
	} catch (err) {
		console.error("[sandbox/outbound] forward failed", { error: (err as Error).message });
		return new Response("forward failed", { status: 502 });
	}
}

export { ContainerProxy } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";
