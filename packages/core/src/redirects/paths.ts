/** Paths excluded from automatic WordPress permalink redirect creation. */
const SKIP_PREFIXES = ["/_emdash", "/_image"];
const ASSET_EXTENSION = /\.\w{1,10}$/;

export function shouldSkipRedirectPath(pathname: string): boolean {
	return (
		SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || ASSET_EXTENSION.test(pathname)
	);
}
