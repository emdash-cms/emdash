export interface GitHubPermit {
	readonly allowed: boolean;
	readonly retryAt: number;
}

export interface GitHubResponseMetadata {
	readonly status: number;
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly resetAt: number | null;
	readonly retryAfterAt: number | null;
}

export interface GitHubRateLimitGate {
	permit(category: string, consumer: string): Promise<GitHubPermit>;
	record(category: string, consumer: string, metadata: GitHubResponseMetadata): Promise<void>;
}

function finiteHeader(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseGitHubResponseMetadata(
	response: Response,
	now = Date.now(),
): GitHubResponseMetadata {
	const resetSeconds = finiteHeader(response.headers.get("x-ratelimit-reset"));
	const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
	let retryAfterAt: number | null = null;
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) retryAfterAt = now + seconds * 1_000;
		else {
			const parsed = Date.parse(retryAfter);
			if (Number.isFinite(parsed)) retryAfterAt = parsed;
		}
	}
	return {
		status: response.status,
		limit: finiteHeader(response.headers.get("x-ratelimit-limit")),
		remaining: finiteHeader(response.headers.get("x-ratelimit-remaining")),
		resetAt: resetSeconds === null ? null : resetSeconds * 1_000,
		retryAfterAt,
	};
}

export function githubRateLimitGate(env: Env): GitHubRateLimitGate {
	return env.GITHUB_RATE_LIMIT.getByName(`installation:${env.GITHUB_APP_INSTALLATION_ID}`);
}
