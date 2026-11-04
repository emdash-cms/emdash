const TRAILING_SLASHES_RE = /\/+$/;

/** Canonicalize a signed source repository URL, or return null when it is unsafe. */
export function canonicalizeRepositoryUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.port
		) {
			return null;
		}
		let path = url.pathname;
		if (path !== "/") path = path.replace(TRAILING_SLASHES_RE, "") || "/";
		return `https://${url.hostname.toLowerCase()}${path}`;
	} catch {
		return null;
	}
}
