import { adaptSandboxEntry } from "../adapt-sandbox-entry.js";
import { normalizeManifestHook } from "../manifest-schema.js";
import { ContentSaveRejectedError } from "../save-rejection.js";
import type { PluginManifest, ResolvedPlugin } from "../types.js";
import type { PageMetadataContribution } from "../types.js";
import { inspectSandboxHookResult } from "./hook-result.js";
import type { SandboxedPluginInstance } from "./types.js";

const SANDBOX_REJECTION = Symbol("emdash:sandbox-save-rejection");

export interface SandboxSaveRejectionDetails {
	pluginId: string;
	reason: string;
}

const VALID_METADATA_KINDS = new Set(["meta", "property", "link", "jsonld"]);
const VALID_LINK_REL = new Set([
	"canonical",
	"alternate",
	"author",
	"license",
	"nlweb",
	"site.standard.document",
]);

function isValidMetadataContribution(value: unknown): value is PageMetadataContribution {
	if (!value || typeof value !== "object" || !("kind" in value)) return false;
	const contribution = value as Record<string, unknown>;
	if (typeof contribution.kind !== "string" || !VALID_METADATA_KINDS.has(contribution.kind)) {
		return false;
	}
	if (contribution.kind === "meta") {
		return typeof contribution.name === "string" && typeof contribution.content === "string";
	}
	if (contribution.kind === "property") {
		return typeof contribution.property === "string" && typeof contribution.content === "string";
	}
	if (contribution.kind === "link") {
		return (
			typeof contribution.href === "string" &&
			typeof contribution.rel === "string" &&
			VALID_LINK_REL.has(contribution.rel)
		);
	}
	return contribution.graph != null && typeof contribution.graph === "object";
}

export function getSandboxSaveRejectionDetails(error: unknown): SandboxSaveRejectionDetails | null {
	if (!(error instanceof ContentSaveRejectedError) || !(SANDBOX_REJECTION in error)) return null;
	const details: unknown = Object.getOwnPropertyDescriptor(error, SANDBOX_REJECTION)?.value;
	if (!details || typeof details !== "object") return null;
	if (!("pluginId" in details) || typeof details.pluginId !== "string") return null;
	if (!("reason" in details) || typeof details.reason !== "string") return null;
	return { pluginId: details.pluginId, reason: details.reason };
}

/**
 * Represent an isolate-backed plugin inside the normal host hook pipeline.
 * The proxy contains metadata and RPC handlers only; plugin code remains in
 * the runner isolate.
 */
export function createSandboxedPluginProxy(
	manifest: PluginManifest,
	instance: SandboxedPluginInstance,
): ResolvedPlugin {
	const hooks: Record<string, unknown> = {};
	for (const entry of manifest.hooks) {
		const hook = normalizeManifestHook(entry);
		// Raw page fragments and site render components remain trusted-only.
		if (hook.name === "page:fragments") continue;

		hooks[hook.name] = {
			handler: async (event: unknown) => {
				const result = await instance.invokeHook(hook.name, event);
				if (hook.name === "page:metadata") {
					if (result == null) return null;
					const contributions = (Array.isArray(result) ? result : [result]).filter(
						isValidMetadataContribution,
					);
					return contributions.length > 0 ? contributions : null;
				}
				if (hook.name !== "content:beforeSave") return result;

				const inspection = inspectSandboxHookResult(result);
				if (inspection.kind === "error") {
					const error = new ContentSaveRejectedError("Save rejected by a sandboxed plugin");
					return Promise.reject(
						Object.assign(error, {
							[SANDBOX_REJECTION]: {
								pluginId: manifest.id,
								reason: inspection.error.reason,
							},
						}),
					);
				}
				if (inspection.kind === "malformed") {
					throw new Error(`Sandboxed plugin "${manifest.id}" returned an invalid hook result`);
				}
				return result;
			},
			priority: hook.priority,
			timeout: hook.timeout,
			dependencies: hook.dependencies,
			errorPolicy: hook.errorPolicy,
			exclusive: hook.exclusive,
		};
	}

	return adaptSandboxEntry(
		{ hooks },
		{
			id: manifest.id,
			version: manifest.version,
			entrypoint: "",
			format: "standard",
			capabilities: manifest.capabilities,
			allowedHosts: manifest.allowedHosts,
			// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- descriptor typing predates composite manifest indexes; adapter preserves them
			storage: manifest.storage as never,
			adminPages: manifest.admin.pages,
			adminWidgets: manifest.admin.widgets,
			settingsSchema: manifest.admin.settingsSchema,
			portableTextBlocks: manifest.admin.portableTextBlocks,
			fieldWidgets: manifest.admin.fieldWidgets,
		},
	);
}
