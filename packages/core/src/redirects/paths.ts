/** Paths served outside the redirect middleware's lookup and 404 logging. */
const SKIP_PREFIXES = ["/_emdash", "/_image"];
const ASSET_EXTENSION = /\.\w{1,10}$/;

export function shouldSkipRedirectPath(pathname: string): boolean {
	return (
		SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || ASSET_EXTENSION.test(pathname)
	);
}
