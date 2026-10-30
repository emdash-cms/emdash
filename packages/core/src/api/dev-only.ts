declare const __EMDASH_TEST_HOOKS__: boolean;

/**
 * Gate for development-only endpoints and behavior (dev-bypass, dev-reset,
 * captured dev emails, localhost registries).
 *
 * True under `astro dev`, and in builds made with `dangerouslyEnableTestHooks`.
 * Both are build-time constants: in a normal production build this returns
 * `false`, and no environment variable or request can change that.
 */
export function isDevOnlyEnabled(): boolean {
	return (
		import.meta.env.DEV || (typeof __EMDASH_TEST_HOOKS__ !== "undefined" && __EMDASH_TEST_HOOKS__)
	);
}
