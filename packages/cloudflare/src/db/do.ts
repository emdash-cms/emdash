/**
 * Durable Object preview database — RUNTIME ENTRY
 *
 * Creates a Kysely dialect backed by a preview Durable Object.
 * Loaded at runtime via virtual module when preview database queries are needed.
 *
 * This module imports directly from cloudflare:workers to access the DO binding.
 * Do NOT import this at config time.
 */

import { env } from "cloudflare:workers";
import type { Dialect } from "kysely";

import type { EmDashPreviewDB } from "./do-class.js";
import { PreviewDODialect } from "./do-dialect.js";
import type { PreviewDBStub } from "./do-dialect.js";
import type { PreviewDOConfig } from "./do-types.js";

/**
 * Create a preview DO dialect from config.
 *
 * The caller is responsible for resolving the DO name (session token).
 * This is passed as `config.name` by the preview middleware.
 */
export function createDialect(config: PreviewDOConfig & { name: string }): Dialect {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding accessed from untyped env object
	const ns = (env as Record<string, unknown>)[config.binding];

	if (!ns) {
		throw new Error(
			`Durable Object binding "${config.binding}" not found in environment. ` +
				`Check your wrangler.jsonc configuration:\n\n` +
				`[durable_objects]\n` +
				`bindings = [\n` +
				`  { name = "${config.binding}", class_name = "EmDashPreviewDB" }\n` +
				`]\n\n` +
				`[[migrations]]\n` +
				`tag = "v1"\n` +
				`new_sqlite_classes = ["EmDashPreviewDB"]`,
		);
	}

	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- DO namespace binding from untyped env object
	const namespace = ns as DurableObjectNamespace<EmDashPreviewDB>;
	const id = namespace.idFromName(config.name);

	// Return a factory that creates a fresh stub per connection.
	const getStub = (): PreviewDBStub => {
		const stub = namespace.get(id);
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Rpc type limitation with unknown in return types
		return stub as PreviewDBStub;
	};

	return new PreviewDODialect({ getStub });
}

// Re-export the DO class and preview middleware for user convenience
export { EmDashPreviewDB } from "./do-class.js";
export { createPreviewMiddleware } from "./do-preview.js";
export type { PreviewMiddlewareConfig } from "./do-preview.js";
export { isBlockedInPreview } from "./do-preview-routes.js";
export { signPreviewUrl, verifyPreviewSignature } from "./do-preview-sign.js";
