export function buildAuthUrl(baseUrl: string, pathname: string): URL {
	const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const normalizedPathname = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	return new URL(normalizedPathname, normalizedBaseUrl);
}
