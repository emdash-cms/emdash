// Replaced by the site's Vite `define`, which also sets them for the server's manifest, so the
// admin bundle and the server it was built with agree. Undefined outside that build, as in tests.
declare const __EMDASH_VERSION__: string;
declare const __EMDASH_COMMIT__: string;

/** The EmDash build this admin bundle belongs to. */
export const ADMIN_BUILD: { readonly version: string; readonly commit: string } = {
	version: typeof __EMDASH_VERSION__ !== "undefined" ? __EMDASH_VERSION__ : "dev",
	commit: typeof __EMDASH_COMMIT__ !== "undefined" ? __EMDASH_COMMIT__ : "dev",
};
