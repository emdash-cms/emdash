const PKT_LINE_HEADER = /^[0-9a-fA-F]{4}$/;
const WHITESPACE = /\s/;
const MAX_RECEIVE_PACK_COMMAND_BYTES = 64 * 1024;
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
	| { allowed: true; stage: "allowed"; refs?: readonly string[] }
	| {
			allowed: false;
			stage: "repository" | "capability" | "receive-pack";
			reason: string;
			refs?: readonly string[];
			parseError?: string;
	  };

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
			return { allowed: true, stage: "allowed" };
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
				? { allowed: true, stage: "allowed", refs: inspection.refs }
				: {
						allowed: false,
						stage: "receive-pack",
						reason: "git push may only update the current issue's bot artifacts branch",
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
			return { allowed: true, stage: "allowed" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "github.com request outside configured repository git operations",
		};
	}

	if (host === "codeload.github.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return { allowed: true, stage: "allowed" };
		}
		return {
			allowed: false,
			stage: "repository",
			reason: "codeload request outside configured repository",
		};
	}

	if (host === "raw.githubusercontent.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return { allowed: true, stage: "allowed" };
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
			return { allowed: true, stage: "allowed" };
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
	const reader = request.clone().body?.getReader();
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
					const allowed = new Set([`refs/heads/bot/artifacts-${issueNumber}`]);
					return { allowed: refs.length > 0 && refs.every((ref) => allowed.has(ref)), refs };
				}
				if (length < 4 || length > MAX_RECEIVE_PACK_COMMAND_BYTES) {
					return { allowed: false, refs, parseError: "invalid pkt-line length" };
				}
				if (buffer.length - offset < length) break;
				const payload = decoder.decode(buffer.subarray(offset + 4, offset + length));
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
	} finally {
		void reader.cancel().catch(() => undefined);
	}
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
