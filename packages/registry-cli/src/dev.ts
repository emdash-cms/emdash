/**
 * `@emdash-cms/registry-cli/dev`
 *
 * Local-development helper for consuming a sandboxed plugin directly
 * from its source directory. Lets a site's `astro.config.mjs` reference
 * a plugin via a directory path instead of importing a factory function:
 *
 * ```ts
 * import { localPlugin } from "@emdash-cms/registry-cli/dev";
 *
 * emdash({
 *   plugins: [
 *     await localPlugin("../packages/plugins/audit-log"),
 *   ],
 * });
 * ```
 *
 * The helper reads the plugin's `emdash-plugin.jsonc`, resolves the
 * publisher's handle to a DID (when needed), and returns a
 * `PluginDescriptor`-shaped object the integration's `plugins:` /
 * `sandboxed:` arrays consume directly. Identity, the trust contract,
 * and the admin surface come from the manifest; the runtime code is
 * loaded by the integration's virtual-module loader from
 * `<dir>/src/plugin.ts` (as an absolute file URL).
 *
 * Failure modes:
 *
 *   - Manifest missing or invalid → `LocalPluginError(MANIFEST_INVALID)`.
 *   - `src/plugin.ts` missing → `LocalPluginError(PLUGIN_ENTRY_MISSING)`.
 *   - Publisher handle can't be resolved → `LocalPluginError(PUBLISHER_UNRESOLVED)`.
 *
 * This helper is for local dev only. Registry-installed plugins go
 * through `emdash-registry bundle` + the runtime's install pipeline —
 * they never touch this module.
 */

import { access } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { isDid, isHandle } from "@atcute/lexicons/syntax";

import { ManifestError, loadManifest } from "./manifest/load.js";
import { PublisherCheckError, resolveHandleToDid } from "./manifest/publisher.js";
import { normaliseManifest, type NormalisedManifest } from "./manifest/translate.js";

export type LocalPluginErrorCode =
	| "MANIFEST_INVALID"
	| "PLUGIN_ENTRY_MISSING"
	| "PUBLISHER_UNRESOLVED";

export class LocalPluginError extends Error {
	override readonly name = "LocalPluginError";
	readonly code: LocalPluginErrorCode;
	constructor(code: LocalPluginErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Plugin descriptor produced by `localPlugin`. The shape mirrors the
 * runtime's `PluginDescriptor` (from `emdash`'s astro integration) but
 * we define the type locally so this module has zero runtime
 * dependency on core — only the type contract matters.
 *
 * `entrypoint` is an absolute `file://` URL pointing at the plugin's
 * `src/plugin.ts`. The integration's virtual-module loader passes
 * that string to a dynamic `import()`, which Vite resolves via its
 * normal filesystem-resolution path.
 */
export interface LocalPluginDescriptor {
	id: string;
	version: string;
	format: "standard";
	entrypoint: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<
		string,
		{ indexes: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>;
	adminPages?: Array<{ path: string; label: string; icon?: string }>;
	adminWidgets?: Array<{ id: string; title?: string; size?: "full" | "half" | "third" }>;
}

export interface LocalPluginOptions {
	/**
	 * If true, suppresses the handle-to-DID resolution at load time.
	 * The descriptor carries whatever value the manifest's `publisher`
	 * field holds verbatim. Useful in tests; rarely needed in real
	 * code.
	 */
	skipPublisherResolution?: boolean;
}

/**
 * Load a sandboxed plugin from a local directory and return a
 * descriptor the EmDash integration can consume.
 *
 * `dir` is resolved relative to the calling module's cwd (typically
 * the site's project root). The directory must contain
 * `emdash-plugin.jsonc` and `src/plugin.ts` — same layout
 * `emdash-registry init` and `emdash-registry bundle` expect.
 *
 * The returned descriptor carries an absolute `file://` URL as its
 * `entrypoint`. The Astro integration's virtual-module loader emits
 * `import plugin from "<entrypoint>"`, which Vite resolves through
 * its standard file-URL → fs path resolver. No build step required.
 */
export async function localPlugin(
	dir: string,
	options: LocalPluginOptions = {},
): Promise<LocalPluginDescriptor> {
	const absDir = resolvePath(dir);

	// Manifest first: identity + trust contract + admin surface.
	let normalised: NormalisedManifest;
	try {
		const { manifest } = await loadManifest(absDir);
		normalised = normaliseManifest(manifest);
	} catch (error) {
		if (error instanceof ManifestError) {
			throw new LocalPluginError("MANIFEST_INVALID", `Plugin at ${absDir}: ${error.message}`);
		}
		throw error;
	}

	// Runtime entry: src/plugin.ts must exist; we don't probe its
	// surface here (Vite will compile it on first import), but we do
	// confirm it's present so the failure surfaces at config-load
	// rather than at first hook fire.
	const pluginEntryPath = join(absDir, "src", "plugin.ts");
	try {
		await access(pluginEntryPath);
	} catch {
		throw new LocalPluginError(
			"PLUGIN_ENTRY_MISSING",
			`Plugin at ${absDir} has no src/plugin.ts. Run \`emdash-registry init\` to scaffold the expected layout, or move your runtime code to that path.`,
		);
	}

	// Resolve the publisher to a DID. The manifest's publisher may
	// be a handle or a DID; the runtime's identity check only cares
	// about the DID. Resolving here means the descriptor passed to
	// the integration is already in the canonical form.
	const did = options.skipPublisherResolution
		? normalised.publisher
		: await resolvePublisher(normalised.publisher);

	return {
		id: normalised.slug,
		version: normalised.version,
		format: "standard",
		entrypoint: pathToFileURL(pluginEntryPath).href,
		capabilities: normalised.capabilities,
		allowedHosts: normalised.allowedHosts,
		storage: normalised.storage,
		// Pass admin surface through only when there's something to
		// declare; integration treats undefined/empty arrays the same
		// way at runtime but the descriptor stays tidier.
		...(normalised.admin.pages.length > 0 && { adminPages: normalised.admin.pages }),
		...(normalised.admin.widgets.length > 0 && { adminWidgets: normalised.admin.widgets }),
		// Note: `did` is computed but not currently exposed on the
		// descriptor. The runtime keys storage / KV / logs by `id`,
		// and id == slug for local-dev installs. When the runtime's
		// ctx.plugin shape gains explicit did / uri fields, this
		// helper feeds them through too.
		...(did !== normalised.publisher && {}),
	};
}

/**
 * Resolve the manifest's publisher to a DID. DIDs pass through
 * verbatim; handles are resolved through the same actor-resolver
 * the publish flow uses. Failure becomes a structured
 * `LocalPluginError` so a site's astro.config.mjs sees a clear
 * error rather than a cryptic resolver stack.
 */
async function resolvePublisher(publisher: string): Promise<string> {
	if (isDid(publisher)) return publisher;
	if (!isHandle(publisher)) {
		throw new LocalPluginError(
			"PUBLISHER_UNRESOLVED",
			`Manifest publisher "${publisher}" is neither a DID nor a valid handle. Fix the publisher field and reload.`,
		);
	}
	try {
		return await resolveHandleToDid(publisher);
	} catch (error) {
		if (error instanceof PublisherCheckError) {
			throw new LocalPluginError("PUBLISHER_UNRESOLVED", error.message);
		}
		throw error;
	}
}
