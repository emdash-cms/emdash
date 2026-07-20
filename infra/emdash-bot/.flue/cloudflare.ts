// Cloudflare-target Durable Object exports. Flue's Vite plugin composes these
// user-owned classes with its generated agent classes in the final Worker.

import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

import { gateGithubRequest, githubAuthHeader } from "./lib/github-proxy.js";
import { mintInstallationToken, readAppCreds } from "./lib/github.js";

const INVESTIGATE_CONTAINER_ID = /^investigate-(\d+)-/;

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
// Gates by host + repo (from env); does NOT gate by anchor issue number --
// the per-anchor scoping was unreliable because runtime overrides could be
// dropped mid-run, leaving subsequent requests with no handler.
Sandbox.outboundByHost = {
	"github.com": handleAuthenticatedGithub,
	"api.github.com": handleAuthenticatedGithub,
	"codeload.github.com": handleAuthenticatedGithub,
	"raw.githubusercontent.com": handleAuthenticatedGithub,
};
console.log("[sandbox/outbound] module loaded; outboundByHost set", {
	hosts: Object.keys(Sandbox.outboundByHost ?? {}),
});

async function handleAuthenticatedGithub(
	request: Request,
	env: Env,
	context: { containerId: string },
): Promise<Response> {
	const url = new URL(request.url);
	const owner = env.GITHUB_OWNER;
	const repo = env.GITHUB_REPO;
	if (!owner || !repo) {
		console.warn("[sandbox/outbound] no repo context configured");
		return new Response("github proxy not configured", { status: 403 });
	}

	const issueNumber = issueNumberFromContainerId(context.containerId);
	const denial = await gateGithubRequest(request, url, owner, repo, issueNumber);
	if (denial) {
		console.warn("[sandbox/outbound] denying", {
			method: request.method,
			host: url.host,
			path: url.pathname,
			reason: denial,
		});
		return new Response(`forbidden: ${denial}`, { status: 403 });
	}

	console.log("[sandbox/outbound] allow", {
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
		console.error("[sandbox/outbound] token mint failed", { error: errorMessage(err) });
		return new Response("token mint failed", { status: 502 });
	}
	const authed = new Request(request);
	authed.headers.set("authorization", githubAuthHeader(url.host, token));
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

function issueNumberFromContainerId(containerId: string): number | undefined {
	const match = INVESTIGATE_CONTAINER_ID.exec(containerId);
	if (!match?.[1]) return undefined;
	const issueNumber = Number(match[1]);
	return Number.isSafeInteger(issueNumber) ? issueNumber : undefined;
}

export { ContainerProxy } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";
