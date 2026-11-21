// Astro's Cloudflare adapter can replace node:module with unenv's unsupported require shim.
export function createRequire() {
	return () => {
		throw new Error("[unenv] module.require is not implemented!");
	};
}
