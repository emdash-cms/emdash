// Cloudflare-target Durable Object exports. Flue's Vite plugin composes these
// user-owned classes with its generated agent classes in the final Worker.

import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";

import { forwardAnonymousRead } from "./lib/anonymous-egress.js";
import { forwardGithubRequest } from "./lib/github-outbound.js";

const GITHUB_TOKEN_BROKER = "github-installation-token";

// Subclass so we can attach an outbound proxy to github.com. The handler runs
// in the Worker runtime (outside the sandbox) with full env access; the
// sandbox holds no credentials. The agent makes a plain HTTPS request, the
// Sandbox runtime's TLS interception decrypts it, the handler adds
// Authorization, and the request is forwarded upstream.
export class Sandbox extends BaseSandbox {
	override enableInternet = false;
	// Required: outbound handlers only see HTTPS traffic when interception is on.
	// Defaults to false in @cloudflare/containers 0.3.x; flip it explicitly.
	override interceptHttps = true;
}

// Public HTTPS reads use a credential-free catch-all. GitHub hosts override it
// so configured-repository operations can receive an installation token and
// pushes remain confined to the current issue's bot branches.
Sandbox.outbound = forwardAnonymousRead;
Sandbox.outboundByHost = {
	"github.com": handleAuthenticatedGithub,
	"api.github.com": handleAuthenticatedGithub,
	"codeload.github.com": handleAuthenticatedGithub,
	"raw.githubusercontent.com": handleAuthenticatedGithub,
};
console.log("[sandbox/outbound] module loaded; outboundByHost set", {
	hosts: Object.keys(Sandbox.outboundByHost ?? {}),
	catchAll: true,
});

async function handleAuthenticatedGithub(request: Request, env: Env): Promise<Response> {
	return forwardGithubRequest(request, {
		owner: env.GITHUB_OWNER,
		repo: env.GITHUB_REPO,
		pushCapabilitySecret: env.GITHUB_WEBHOOK_SECRET,
		getInstallationToken: () =>
			env.Orchestrator.getByName(GITHUB_TOKEN_BROKER).getInstallationTokenForGitProxy(),
	});
}

export { ContainerProxy } from "@cloudflare/sandbox";
export { OrchestratorDO } from "./lib/orchestrator.js";
