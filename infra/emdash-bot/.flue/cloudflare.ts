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
		// node-gyp fetches node headers from here when building native
		// modules (better-sqlite3 etc.).
		"nodejs.org",
	];
}

interface GitHubAuthParams {
	anchorNumber: number;
	owner: string;
	repo: string;
}

// Named handler installed per-run by the workflow with the anchor + repo
// context. The workflow calls sandbox.setOutboundByHost("api.github.com",
// "authenticatedGithub", { anchorNumber, owner, repo }) before starting the
// agent's session.
Sandbox.outboundHandlers = {
	authenticatedGithub: handleAuthenticatedGithub as never,
};

async function handleAuthenticatedGithub(
	request: Request,
	env: Env,
	ctx: { containerId: string; className: string; params?: GitHubAuthParams },
): Promise<Response> {
	const url = new URL(request.url);
	const params = ctx.params;
	if (!params) {
		console.warn("[sandbox/outbound] denying: no params", { path: url.pathname });
		return new Response("github proxy not configured for this run", { status: 403 });
	}

	const denial = gateRequest(request, url, params);
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
		console.error("[sandbox/outbound] token mint failed", { error: (err as Error).message });
		return new Response("token mint failed", { status: 502 });
	}
	const authed = new Request(request);
	// Basic auth for git smart HTTP; same Basic also works for the REST API.
	authed.headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
	authed.headers.set("user-agent", "emdash-bot");
	try {
		const res = await fetch(authed);
		console.log("[sandbox/outbound] response", {
			path: url.pathname,
			status: res.status,
		});
		return res;
	} catch (err) {
		console.error("[sandbox/outbound] forward failed", { error: (err as Error).message });
		return new Response("forward failed", { status: 502 });
	}
}

/**
 * Decide whether the agent's request is one we're willing to sign. Returns a
 * deny reason string, or null to allow.
 *
 * The agent can:
 *   - Do anything via git smart HTTP against {owner}/{repo} (clone, fetch,
 *     push to bot/fix-<anchorNumber>).
 *   - GET anything on api.github.com (read issues, PRs, repos, contents).
 *   - POST comments / reactions on its OWN anchor issue.
 *   - PATCH/POST on its OWN anchor issue/PR (e.g. edit PR body if PR open).
 *
 * The agent cannot:
 *   - Write to a different repo (even in the same org).
 *   - Write to a different issue/PR (anti-cross-issue tampering).
 *   - Hit /orgs/, /users/, /admin/ endpoints.
 *   - Use github.com paths that aren't git smart HTTP for {owner}/{repo}.
 */
function gateRequest(
	request: Request,
	url: URL,
	params: GitHubAuthParams,
): string | null {
	const { anchorNumber, owner, repo } = params;
	const method = request.method.toUpperCase();
	const host = url.host;

	// github.com: only git smart HTTP for the configured repo.
	if (host === "github.com") {
		const repoPrefix = `/${owner}/${repo}.git/`;
		if (url.pathname.startsWith(repoPrefix)) return null;
		// Some legitimate paths the sandbox runtime / git tooling hits:
		if (url.pathname === `/${owner}/${repo}` || url.pathname === `/${owner}/${repo}/`) return null;
		return `github.com path "${url.pathname}" outside ${repoPrefix}`;
	}

	if (host === "codeload.github.com") {
		// Source tarballs (used by some package installers).
		if (url.pathname.startsWith(`/${owner}/${repo}/`)) return null;
		return `codeload path outside repo`;
	}

	if (host === "raw.githubusercontent.com" || host === "objects.githubusercontent.com") {
		// Public blob CDNs. Reads only.
		if (method !== "GET" && method !== "HEAD") return `${host} only allows GET/HEAD`;
		return null;
	}

	if (host === "api.github.com") {
		// All reads are fine.
		if (method === "GET" || method === "HEAD") return null;

		// Writes must target the current anchor issue/PR or this repo's
		// general write endpoints we intentionally allow.
		const repoBase = `/repos/${owner}/${repo}`;
		if (!url.pathname.startsWith(`${repoBase}/`)) {
			return `write to ${url.pathname} outside ${repoBase}`;
		}

		// /repos/<owner>/<repo>/issues/<anchor>/...   — comments, reactions, labels (orchestrator manages labels normally, but allow it)
		// /repos/<owner>/<repo>/pulls/<anchor>/...    — review comments etc. (only fires once PR open; anchor == PR number in our model)
		const issueRe = new RegExp(`^${escapeRegex(repoBase)}/issues/(\\d+)(?:/|$)`);
		const pullRe = new RegExp(`^${escapeRegex(repoBase)}/pulls/(\\d+)(?:/|$)`);
		const m = issueRe.exec(url.pathname) ?? pullRe.exec(url.pathname);
		if (m) {
			const numStr = m[1];
			if (numStr === undefined) return `unparseable issue/pr number`;
			const n = parseInt(numStr, 10);
			if (n !== anchorNumber) {
				return `write to issue/PR #${n} != anchor #${anchorNumber}`;
			}
			return null;
		}

		return `write to ${url.pathname} outside anchor-scoped endpoints`;
	}

	return `host ${host} not gated`;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { ContainerProxy } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";
