/**
 * Test fixture: minimal sandbox entry. Exports a default object with hooks
 * and routes so the bundler's probe captures shape into the manifest.
 *
 * The empty `definePlugin` import would normally come from `emdash`; the
 * bundler stubs it with an identity function via its probe shim.
 */
export default {
	hooks: {
		"content:beforeCreate": (input: unknown) => input,
	},
	routes: {
		admin: () => new Response("ok"),
	},
};
