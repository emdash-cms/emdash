import {
	githubGateDenialResponse,
	inspectGithubRequest,
	PUSH_CAPABILITY_HEADER,
	pushCapabilityFromAuthorization,
	verifyPushCapability,
	withGithubAuthorization,
} from "./github-proxy.js";

export interface GithubOutboundContext {
	readonly owner: string;
	readonly repo: string;
	readonly pushCapabilitySecret: string;
	readonly getInstallationToken: () => Promise<string>;
}

export async function forwardGithubRequest(
	request: Request,
	context: GithubOutboundContext,
	upstreamFetch: typeof fetch = fetch,
): Promise<Response> {
	const url = new URL(request.url);
	if (!context.owner || !context.repo) {
		console.warn(JSON.stringify({ message: "github proxy not configured" }));
		return new Response("github proxy not configured", { status: 403 });
	}

	const forwarded = new Request(request);
	const authorizationCapability = pushCapabilityFromAuthorization(
		forwarded.headers.get("authorization"),
	);
	const legacyCapability = forwarded.headers.get(PUSH_CAPABILITY_HEADER);
	const capability = authorizationCapability ?? legacyCapability;
	const issueNumber = await verifyPushCapability(
		capability,
		context.pushCapabilitySecret,
		context.owner,
		context.repo,
	);
	forwarded.headers.delete("authorization");
	forwarded.headers.delete(PUSH_CAPABILITY_HEADER);
	const gate = await inspectGithubRequest(
		forwarded,
		url,
		context.owner,
		context.repo,
		issueNumber ?? undefined,
	);
	if (!gate.allowed) {
		console.warn(
			JSON.stringify({
				message: "github proxy denied request",
				method: request.method,
				host: url.host,
				path: url.pathname,
				stage: gate.stage,
				reason: gate.reason,
				capabilityPresent: capability !== null,
				capabilityValid: issueNumber !== null,
				capabilityTransport: authorizationCapability
					? "authorization"
					: legacyCapability
						? "legacy-header"
						: "missing",
				...(gate.refs ? { refs: gate.refs } : {}),
				...(gate.parseError ? { parseError: gate.parseError } : {}),
			}),
		);
		return githubGateDenialResponse(gate);
	}

	let token: string | null = null;
	if (gate.authentication === "installation") {
		try {
			token = await context.getInstallationToken();
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "github proxy authentication unavailable",
					method: request.method,
					path: url.pathname,
					error: errorMessage(error),
				}),
			);
			return new Response("github authentication unavailable", { status: 502 });
		}
	}

	console.log(
		JSON.stringify({
			message: "github proxy forwarding request",
			method: request.method,
			host: url.host,
			path: url.pathname,
			authentication: gate.authentication,
		}),
	);
	const authed = withGithubAuthorization(forwarded, url.host, token);
	authed.headers.set("user-agent", "emdash-bot");
	try {
		const response = await upstreamFetch(authed, {
			signal: AbortSignal.timeout(2 * 60_000),
		});
		console.log(
			JSON.stringify({
				message: "github proxy received response",
				path: url.pathname,
				status: response.status,
			}),
		);
		return response;
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "github proxy forward failed",
				path: url.pathname,
				error: errorMessage(error),
			}),
		);
		return new Response("forward failed", { status: 502 });
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
