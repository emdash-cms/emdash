const PKT_LINE_HEADER = /^[0-9a-fA-F]{4}$/;
const BASIC_AUTHORIZATION = /^Basic ([A-Za-z0-9+/]+={0,2})$/i;
const SHALLOW_DECLARATION = /^shallow (?:[0-9a-f]{40}|[0-9a-f]{64})\n?$/i;
const WHITESPACE = /\s/;
const MAX_RECEIVE_PACK_COMMAND_BYTES = 64 * 1024;
const PUSH_CAPABILITY_USERNAME = "emdashbot";
export const PUSH_CAPABILITY_HEADER = "X-EmDash-Push-Capability";

export async function createPushCapability(
	secret: string,
	owner: string,
	repo: string,
	issueNumber: number,
): Promise<string> {
	if (!secret) throw new Error("push capability secret is not configured");
	const payload = String(issueNumber);
	return `${payload}.${await signPushCapability(secret, `${owner}/${repo}/${payload}`)}`;
}

export async function verifyPushCapability(
	capability: string | null,
	secret: string,
	owner: string,
	repo: string,
): Promise<number | null> {
	if (!capability || !secret) return null;
	const separator = capability.indexOf(".");
	if (separator <= 0) return null;
	const payload = capability.slice(0, separator);
	const signature = capability.slice(separator + 1);
	const issueNumber = Number(payload);
	if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0 || !signature) return null;

	try {
		const key = await importPushCapabilityKey(secret, ["verify"]);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			decodeBase64Url(signature),
			new TextEncoder().encode(`${owner}/${repo}/${payload}`),
		);
		return valid ? issueNumber : null;
	} catch {
		return null;
	}
}

export function githubPushUrl(owner: string, repo: string, capability: string): string {
	if (!capability) throw new Error("push capability is not configured");
	const url = new URL(`https://github.com/${owner}/${repo}.git`);
	url.username = PUSH_CAPABILITY_USERNAME;
	url.password = capability;
	return url.toString();
}

export function pushCapabilityFromAuthorization(authorization: string | null): string | null {
	const match = BASIC_AUTHORIZATION.exec(authorization ?? "");
	if (!match?.[1]) return null;

	try {
		const credentials = atob(match[1]);
		const separator = credentials.indexOf(":");
		if (separator === -1 || credentials.slice(0, separator) !== PUSH_CAPABILITY_USERNAME) {
			return null;
		}
		return credentials.slice(separator + 1) || null;
	} catch {
		return null;
	}
}

async function signPushCapability(secret: string, payload: string): Promise<string> {
	const key = await importPushCapabilityKey(secret, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return encodeBase64Url(new Uint8Array(signature));
}

function importPushCapabilityKey(
	secret: string,
	usages: Array<"sign" | "verify">,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usages,
	);
}

function encodeBase64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/**
 * Auth scheme for the sandbox outbound GitHub proxy.
 * - api.github.com expects `Authorization: Bearer <installation_token>`
 * - git HTTPS hosts (github.com, codeload, raw) expect Basic x-access-token
 */
export function githubAuthHeader(host: string, token: string): string {
	if (host === "api.github.com") return `Bearer ${token}`;
	return `Basic ${btoa(`x-access-token:${token}`)}`;
}

export function withGithubAuthorization(
	request: Request,
	host: string,
	token: string | null,
): Request {
	const forwarded = new Request(request);
	forwarded.headers.delete("authorization");
	if (token) forwarded.headers.set("authorization", githubAuthHeader(host, token));
	return forwarded;
}

export async function gateGithubRequest(
	request: Request,
	url: URL,
	owner: string,
	repo: string,
	issueNumber?: number,
): Promise<string | null> {
	const result = await inspectGithubRequest(request, url, owner, repo, issueNumber);
	return result.allowed ? null : result.reason;
}

export type GithubGateResult =
	| {
			allowed: true;
			stage: "allowed";
			authentication: "anonymous" | "installation";
			refs?: readonly string[];
	  }
	| {
			allowed: false;
			stage: "repository" | "capability" | "receive-pack";
			reason: string;
			refs?: readonly string[];
			parseError?: string;
	  };

export function githubGateDenialResponse(
	result: Extract<GithubGateResult, { allowed: false }>,
): Response {
	const headers = new Headers({ "x-emdash-proxy-stage": result.stage });
	if (result.stage === "capability") {
		headers.set("www-authenticate", 'Basic realm="EmDash candidate push", charset="UTF-8"');
	}
	return new Response(`forbidden: ${result.reason}`, {
		status: result.stage === "capability" ? 401 : 403,
		headers,
	});
}

export async function inspectGithubRequest(
	request: Request,
	url: URL,
	owner: string,
	repo: string,
	issueNumber?: number,
): Promise<GithubGateResult> {
	const method = request.method.toUpperCase();
	const host = url.host;

	if (host === "github.com") {
		const repoPath = `/${owner}/${repo}`;
		const gitPath = `${repoPath}.git`;
		if (
			(method === "GET" || method === "HEAD") &&
			(url.pathname === repoPath || url.pathname === `${repoPath}/`)
		) {
			return { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (
			url.pathname === `${gitPath}/info/refs` &&
			(method === "GET" || method === "HEAD") &&
			url.searchParams.get("service") === "git-receive-pack"
		) {
			return issueNumber === undefined
				? {
						allowed: false,
						stage: "capability",
						reason: "git push requires a valid issue-scoped capability",
					}
				: { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (url.pathname === `${gitPath}/git-receive-pack` && method === "POST") {
			if (issueNumber === undefined) {
				return {
					allowed: false,
					stage: "capability",
					reason: "git push requires a valid issue-scoped capability",
				};
			}
			const inspection = await inspectReceivePack(request, issueNumber);
			return inspection.allowed
				? {
						allowed: true,
						stage: "allowed",
						authentication: "installation",
						refs: inspection.refs,
					}
				: {
						allowed: false,
						stage: "receive-pack",
						reason: "git push may only update the current issue's bot branch",
						refs: inspection.refs,
						parseError: inspection.parseError,
					};
		}
		if (
			(url.pathname === gitPath ||
				url.pathname === `${gitPath}/` ||
				url.pathname === `${gitPath}/info/refs` ||
				url.pathname === `${gitPath}/git-upload-pack`) &&
			(method === "GET" || method === "HEAD" || method === "POST")
		) {
			return { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (method === "GET" || method === "HEAD") {
			return { allowed: true, stage: "allowed", authentication: "anonymous" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "github.com request outside configured repository git operations",
		};
	}

	if (host === "codeload.github.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (method === "GET" || method === "HEAD") {
			return { allowed: true, stage: "allowed", authentication: "anonymous" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "codeload request outside configured repository",
		};
	}

	if (host === "raw.githubusercontent.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (method === "GET" || method === "HEAD") {
			return { allowed: true, stage: "allowed", authentication: "anonymous" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "raw content request outside configured repository",
		};
	}

	if (host === "api.github.com") {
		const repoBase = `/repos/${owner}/${repo}`;
		if (
			(method === "GET" || method === "HEAD") &&
			(url.pathname === repoBase || url.pathname.startsWith(`${repoBase}/`))
		) {
			return { allowed: true, stage: "allowed", authentication: "installation" };
		}
		if (method === "GET" || method === "HEAD") {
			return { allowed: true, stage: "allowed", authentication: "anonymous" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "GitHub API access is read-only and limited to the configured repository",
		};
	}

	return {
		allowed: false,
		stage: "repository",
		reason: `host ${host} is not allowed through the authenticated proxy`,
	};
}

async function inspectReceivePack(
	request: Request,
	issueNumber: number,
): Promise<{ allowed: boolean; refs: string[]; parseError?: string }> {
	const cloned = request.clone();
	let body = cloned.body;
	const contentEncoding = cloned.headers.get("content-encoding")?.trim().toLowerCase();
	if (body && contentEncoding === "gzip") {
		body = body.pipeThrough(new DecompressionStream("gzip"));
	} else if (contentEncoding && contentEncoding !== "identity") {
		return {
			allowed: false,
			refs: [],
			parseError: `unsupported receive-pack content encoding: ${contentEncoding}`,
		};
	}
	const reader = body?.getReader();
	if (!reader) return { allowed: false, refs: [], parseError: "request body is missing" };
	let buffer = new Uint8Array();
	let offset = 0;
	const refs: string[] = [];
	const decoder = new TextDecoder();

	try {
		for (;;) {
			while (buffer.length - offset >= 4) {
				const header = decoder.decode(buffer.subarray(offset, offset + 4));
				if (!PKT_LINE_HEADER.test(header)) {
					return { allowed: false, refs, parseError: "invalid pkt-line header" };
				}
				const length = Number.parseInt(header, 16);
				if (length === 0) {
					const allowed = new Set([
						`refs/heads/bot/fix-${issueNumber}`,
						`refs/heads/bot/artifacts-${issueNumber}`,
					]);
					return { allowed: refs.length > 0 && refs.every((ref) => allowed.has(ref)), refs };
				}
				if (length < 4 || length > MAX_RECEIVE_PACK_COMMAND_BYTES) {
					return { allowed: false, refs, parseError: "invalid pkt-line length" };
				}
				if (buffer.length - offset < length) break;
				const payload = decoder.decode(buffer.subarray(offset + 4, offset + length));
				if (isShallowDeclaration(payload)) {
					offset += length;
					continue;
				}
				const ref = receivePackCommandRef(payload);
				if (!ref) {
					return { allowed: false, refs, parseError: "invalid receive-pack command" };
				}
				refs.push(ref);
				offset += length;
			}

			if (offset > 0) {
				buffer = buffer.slice(offset);
				offset = 0;
			}
			if (buffer.length >= MAX_RECEIVE_PACK_COMMAND_BYTES) {
				return { allowed: false, refs, parseError: "receive-pack command prefix is too large" };
			}
			const { done, value } = await reader.read();
			if (done) return { allowed: false, refs, parseError: "receive-pack ended before flush" };
			const remaining = MAX_RECEIVE_PACK_COMMAND_BYTES - buffer.length;
			const chunk = value.subarray(0, remaining);
			const next = new Uint8Array(buffer.length + chunk.length);
			next.set(buffer);
			next.set(chunk, buffer.length);
			buffer = next;
		}
	} catch {
		return { allowed: false, refs, parseError: "invalid compressed receive-pack body" };
	} finally {
		void reader.cancel().catch(() => undefined);
	}
}

function isShallowDeclaration(payload: string): boolean {
	return SHALLOW_DECLARATION.test(payload);
}

function receivePackCommandRef(payload: string): string | null {
	const capabilitySeparator = payload.indexOf(String.fromCharCode(0));
	let command = payload.slice(0, capabilitySeparator === -1 ? payload.length : capabilitySeparator);
	if (command.endsWith("\n")) command = command.slice(0, -1);
	const firstSpace = command.indexOf(" ");
	const secondSpace = command.indexOf(" ", firstSpace + 1);
	if (firstSpace <= 0 || secondSpace <= firstSpace + 1 || command.includes(" ", secondSpace + 1)) {
		return null;
	}
	const ref = command.slice(secondSpace + 1);
	return ref.startsWith("refs/") && !WHITESPACE.test(ref) ? ref : null;
}
