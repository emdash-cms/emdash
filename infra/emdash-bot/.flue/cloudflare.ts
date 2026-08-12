// Cloudflare-target Durable Object exports. Flue's Vite plugin composes these
// user-owned classes with its generated agent classes in the final Worker.

import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

import {
	githubAuthHeader,
	inspectGithubRequest,
	PUSH_CAPABILITY_HEADER,
	verifyPushCapability,
} from "./lib/github-proxy.js";
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
		// node-gyp fetches node headers from here when building native
		// modules (better-sqlite3 etc.).
		"nodejs.org",
	];
}

// Static, always-on handler for github hosts. Bound at module load via
// `outboundByHost` so it survives sandbox restarts / runtime override drops.
// Gates by host + repo (from env). Pushes additionally require an issue-scoped
// capability supplied by the investigation sandbox.
Sandbox.outboundByHost = {
	"github.com": handleAuthenticatedGithub,
	"api.github.com": handleAuthenticatedGithub,
	"codeload.github.com": handleAuthenticatedGithub,
	"raw.githubusercontent.com": handleAuthenticatedGithub,
};
console.log("[sandbox/outbound] module loaded; outboundByHost set", {
	hosts: Object.keys(Sandbox.outboundByHost ?? {}),
});

async function handleAuthenticatedGithub(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const owner = env.GITHUB_OWNER;
	const repo = env.GITHUB_REPO;
	if (!owner || !repo) {
		console.warn("[sandbox/outbound] no repo context configured");
		return new Response("github proxy not configured", { status: 403 });
	}

	const forwarded = new Request(request);
	const capability = forwarded.headers.get(PUSH_CAPABILITY_HEADER);
	const issueNumber = await verifyPushCapability(
		capability,
		env.GITHUB_WEBHOOK_SECRET,
		owner,
		repo,
	);
	forwarded.headers.delete(PUSH_CAPABILITY_HEADER);
	const gate = await inspectGithubRequest(forwarded, url, owner, repo, issueNumber ?? undefined);
	if (!gate.allowed) {
		console.warn("[sandbox/outbound] denying", {
			method: request.method,
			host: url.host,
			path: url.pathname,
			stage: gate.stage,
			reason: gate.reason,
			capabilityPresent: capability !== null,
			capabilityValid: issueNumber !== null,
			...(gate.refs ? { refs: gate.refs } : {}),
			...(gate.parseError ? { parseError: gate.parseError } : {}),
		});
		return new Response(`forbidden: ${gate.reason}`, { status: 403 });
	}

	console.log("[sandbox/outbound] allow", {
		method: request.method,
		host: url.host,
		path: url.pathname,
	});

	// The repo is public: when no usable App credential exists, forward the
	// (already gated) request anonymously. Reads work; a push fails upstream.
	const creds = readAppCreds(env);
	let token: string | null = null;
	if (creds) {
		try {
			token = await mintInstallationToken(creds);
		} catch (err) {
			console.warn("[sandbox/outbound] token mint failed; forwarding anonymously", {
				error: errorMessage(err),
			});
		}
	}
	const authed = new Request(forwarded);
	if (token) authed.headers.set("authorization", githubAuthHeader(url.host, token));
	authed.headers.set("user-agent", "emdash-bot");
	try {
		const res = await fetch(authed, { signal: AbortSignal.timeout(2 * 60_000) });
		console.log("[sandbox/outbound] response", {
			path: url.pathname,
			status: res.status,
		});
		return res;
	} catch (err) {
		console.error("[sandbox/outbound] forward failed", { error: errorMessage(err) });
		return new Response("forward failed", { status: 502 });
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { ContainerProxy } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";
