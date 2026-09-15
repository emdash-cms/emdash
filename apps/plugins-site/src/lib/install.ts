const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

export function normalizeSiteOrigin(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 2_048) return undefined;

	const candidate = URL_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;

	try {
		const url = new URL(candidate);
		if (url.username || url.password) return undefined;
		if (url.protocol === "https:") return url.origin;
		if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) {
			return url.origin;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

export function pluginAdminUrl(
	siteOrigin: string,
	publisher: string,
	slug: string,
): string | undefined {
	const origin = normalizeSiteOrigin(siteOrigin);
	if (!origin) return undefined;

	return new URL(
		`/_emdash/admin/plugins/registry/${encodeURIComponent(publisher)}/${encodeURIComponent(slug)}`,
		origin,
	).href;
}
