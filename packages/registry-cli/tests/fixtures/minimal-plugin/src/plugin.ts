/**
 * Test fixture: minimal sandbox entry. Exports a default object with hooks
 * and routes so the bundler's probe captures shape into the manifest.
 *
 * Uses `definePlugin` from "emdash" (which the bundler aliases to a Proxy
 * shim) so the shim resolution path is actually exercised by the bundle
 * tests; without this `import`, the shim could be silently broken and tests
 * would still pass.
 */
// eslint-disable-next-line import/no-unresolved -- the bundler aliases this
import { definePlugin } from "emdash";

export default definePlugin({
	hooks: {
		"content:beforeCreate": (input: unknown) => input,
	},
	routes: {
		admin: () => new Response("ok"),
	},
});
