/**
 * Test fixture: minimal sandbox entry. Exports a default object with hooks
 * and routes so the bundler's probe captures shape into the manifest.
 *
 * Uses the new authoring shape: bare default export with a
 * `satisfies SandboxedPlugin` annotation. The import is type-only, so
 * the bundler erases it — no runtime resolution of `emdash/plugin`
 * needed.
 */
import type { SandboxedPlugin } from "emdash/plugin";

// `content:beforeCreate` isn't in the strict mapped type, so use the
// canonical content hook name. Test assertions also expect `content:beforeSave`
// via the runtime hook vocabulary.
export default {
	hooks: {
		"content:beforeSave": (event) => Promise.resolve(event.content),
	},
	routes: {
		admin: () => Promise.resolve(new Response("ok")),
	},
} satisfies SandboxedPlugin;
