const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const URL_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

export type SiteProbeResult = "registry" | "registry-disabled" | "legacy" | "unknown";

type SiteProbeRequest = (input: URL, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

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

export async function probeEmDashSite(
	siteOrigin: string,
	signal: AbortSignal,
	request: SiteProbeRequest = fetch,
): Promise<SiteProbeResult> {
	const origin = normalizeSiteOrigin(siteOrigin);
	if (!origin) return "unknown";

	try {
		const response = await request(new URL("/_emdash/api/health", origin), {
			headers: { Accept: "application/json" },
			credentials: "omit",
			signal,
		});
		const body = response.ok ? await responseJson(response) : undefined;
		const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
		if (body && data?.product === "emdash") {
			if (data.registry === true) return "registry";
			if (data.registry === false) return "registry-disabled";
		}
	} catch {
		// Older or access-protected sites can continue through OAuth discovery.
	}

	try {
		const response = await request(
			new URL("/.well-known/oauth-authorization-server/_emdash", origin),
			{
				headers: { Accept: "application/json" },
				credentials: "omit",
				signal,
			},
		);
		const metadata = response.ok ? await responseJson(response) : undefined;
		if (
			isRecord(metadata) &&
			typeof metadata.issuer === "string" &&
			new URL(metadata.issuer).pathname === "/_emdash" &&
			typeof metadata.authorization_endpoint === "string" &&
			typeof metadata.token_endpoint === "string"
		) {
			return "legacy";
		}
	} catch {
		return "unknown";
	}

	return "unknown";
}
