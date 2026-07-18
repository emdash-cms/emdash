const GIT_REF = /refs\/(?:heads|tags)\/\S+/g;
const PKT_LINE_HEADER = /^[0-9a-fA-F]{4}$/;
const MAX_RECEIVE_PACK_COMMAND_BYTES = 64 * 1024;

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
	const method = request.method.toUpperCase();
	const host = url.host;

	if (host === "github.com") {
		const repoPath = `/${owner}/${repo}`;
		const gitPath = `${repoPath}.git`;
		if (
			(method === "GET" || method === "HEAD") &&
			(url.pathname === repoPath || url.pathname === `${repoPath}/`)
		) {
			return null;
		}
		if (url.pathname === `${gitPath}/git-receive-pack` && method === "POST") {
			return issueNumber !== undefined && (await hasOnlyBotBranchUpdates(request, issueNumber))
				? null
				: "git push may only update the current issue's bot fix branch";
		}
		if (
			(url.pathname === gitPath ||
				url.pathname === `${gitPath}/` ||
				url.pathname === `${gitPath}/info/refs` ||
				url.pathname === `${gitPath}/git-upload-pack`) &&
			(method === "GET" || method === "HEAD" || method === "POST")
		) {
			return null;
		}
		return `github.com request outside configured repository git operations`;
	}

	if (host === "codeload.github.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return null;
		}
		return "codeload request outside configured repository";
	}

	if (host === "raw.githubusercontent.com") {
		if ((method === "GET" || method === "HEAD") && url.pathname.startsWith(`/${owner}/${repo}/`)) {
			return null;
		}
		return "raw content request outside configured repository";
	}

	if (host === "api.github.com") {
		const repoBase = `/repos/${owner}/${repo}`;
		if (
			(method === "GET" || method === "HEAD") &&
			(url.pathname === repoBase || url.pathname.startsWith(`${repoBase}/`))
		) {
			return null;
		}
		return "GitHub API access is read-only and limited to the configured repository";
	}

	return `host ${host} is not allowed through the authenticated proxy`;
}

async function hasOnlyBotBranchUpdates(request: Request, issueNumber: number): Promise<boolean> {
	const reader = request.clone().body?.getReader();
	if (!reader) return false;
	let buffer = new Uint8Array();
	let offset = 0;
	const refs: string[] = [];
	const decoder = new TextDecoder();

	try {
		for (;;) {
			while (buffer.length - offset >= 4) {
				const header = decoder.decode(buffer.subarray(offset, offset + 4));
				if (!PKT_LINE_HEADER.test(header)) return false;
				const length = Number.parseInt(header, 16);
				if (length === 0) {
					const expected = `refs/heads/bot/fix-${issueNumber}`;
					return refs.length > 0 && refs.every((ref) => ref === expected);
				}
				if (length < 4 || length > MAX_RECEIVE_PACK_COMMAND_BYTES) return false;
				if (buffer.length - offset < length) break;
				const payload = decoder
					.decode(buffer.subarray(offset + 4, offset + length))
					.replaceAll(String.fromCharCode(0), " ");
				refs.push(...(payload.match(GIT_REF) ?? []));
				offset += length;
			}

			if (offset > 0) {
				buffer = buffer.slice(offset);
				offset = 0;
			}
			if (buffer.length >= MAX_RECEIVE_PACK_COMMAND_BYTES) return false;
			const { done, value } = await reader.read();
			if (done) return false;
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
