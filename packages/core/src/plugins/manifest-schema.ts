/**
 * Zod schema for PluginManifest validation
 *
 * Used to validate manifest.json from plugin bundles at every parse site:
 * - Client-side download (marketplace.ts extractBundle)
 * - R2 load (api/handlers/marketplace.ts loadBundleFromR2)
 * - CLI publish preview (cli/commands/publish.ts readManifestFromTarball)
 * - Marketplace ingest extends this with publishing-specific fields
 */

import { z } from "zod";

// ── Enum values (must stay in sync with types.ts) ───────────────

export const PLUGIN_CAPABILITIES = [
	"network:fetch",
	"network:fetch:any",
	"read:content",
	"write:content",
	"read:media",
	"write:media",
	"read:users",
	"email:send",
	"email:provide",
	"email:intercept",
	"page:inject",
] as const;

/** Must stay in sync with FieldType in schema/types.ts */
const FIELD_TYPES = [
	"string",
	"text",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"portableText",
	"image",
	"file",
	"reference",
	"json",
	"slug",
	"repeater",
] as const;

export const HOOK_NAMES = [
	"plugin:install",
	"plugin:activate",
	"plugin:deactivate",
	"plugin:uninstall",
	"content:beforeSave",
	"content:afterSave",
	"content:beforeDelete",
	"content:afterDelete",
	"content:afterPublish",
	"content:afterUnpublish",
	"media:beforeUpload",
	"media:afterUpload",
	"cron",
	"email:beforeSend",
	"email:deliver",
	"email:afterSend",
	"comment:beforeCreate",
	"comment:moderate",
	"comment:afterCreate",
	"comment:afterModerate",
	"page:metadata",
	"page:fragments",
] as const;

/**
 * Structured hook entry for manifest — name plus optional metadata.
 * During a transition period, both plain strings and objects are accepted.
 */
const manifestHookEntrySchema = z.object({
	name: z.enum(HOOK_NAMES),
	exclusive: z.boolean().optional(),
	priority: z.number().int().optional(),
	timeout: z.number().int().positive().optional(),
});

/**
 * Structured route entry for manifest — name plus optional metadata.
 * Both plain strings and objects are accepted; strings are normalized
 * to `{ name }` objects via `normalizeManifestRoute()`.
 */
/** Route names must be safe path segments — alphanumeric, hyphens, underscores, forward slashes */
const routeNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/;

const manifestRouteEntrySchema = z.object({
	name: z.string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
	public: z.boolean().optional(),
});

// ── Sub-schemas ─────────────────────────────────────────────────

/** Index field names must be valid identifiers to prevent SQL injection via JSON path expressions */
const indexFieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);

const storageCollectionSchema = z.object({
	indexes: z.array(z.union([indexFieldName, z.array(indexFieldName)])),
	uniqueIndexes: z.array(z.union([indexFieldName, z.array(indexFieldName)])).optional(),
});

const baseSettingFields = {
	label: z.string(),
	description: z.string().optional(),
};

const settingFieldSchema = z.discriminatedUnion("type", [
	z.object({
		...baseSettingFields,
		type: z.literal("string"),
		default: z.string().optional(),
		multiline: z.boolean().optional(),
	}),
	z.object({
		...baseSettingFields,
		type: z.literal("number"),
		default: z.number().optional(),
		min: z.number().optional(),
		max: z.number().optional(),
	}),
	z.object({ ...baseSettingFields, type: z.literal("boolean"), default: z.boolean().optional() }),
	z.object({
		...baseSettingFields,
		type: z.literal("select"),
		options: z.array(z.object({ value: z.string(), label: z.string() })),
		default: z.string().optional(),
	}),
	z.object({ ...baseSettingFields, type: z.literal("secret") }),
	z.object({ ...baseSettingFields, type: z.literal("url") }),
	z.object({ ...baseSettingFields, type: z.literal("email") })
]);

const adminPageSchema = z.object({
	path: z.string(),
	label: z.string(),
	icon: z.string().optional(),
});

const dashboardWidgetSchema = z.object({
	id: z.string(),
	size: z.enum(["full", "half", "third"]).optional(),
	title: z.string().optional(),
});

const pluginAdminConfigSchema = z.object({
	entry: z.string().optional(),
	settingsSchema: z.record(z.string(), settingFieldSchema).optional(),
	pages: z.array(adminPageSchema).optional(),
	widgets: z.array(dashboardWidgetSchema).optional(),
	fieldWidgets: z
		.array(
			z.object({
				name: z.string().min(1),
				label: z.string().min(1),
				fieldTypes: z.array(z.enum(FIELD_TYPES)),
				elements: z
					.array(
						z
							.object({
								type: z.string(),
								action_id: z.string(),
								label: z.string().optional(),
							})
							.passthrough(),
					)
					.optional(),
			}),
		)
		.optional(),
});

// ── Main schema ─────────────────────────────────────────────────

/**
 * Zod schema matching the PluginManifest interface from types.ts.
 *
 * Every JSON.parse of a manifest.json should validate through this.
 */
export const pluginManifestSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)),
	allowedHosts: z.array(z.string()),
	storage: z.record(z.string(), storageCollectionSchema),
	/**
	 * Hook declarations — accepts both plain name strings (legacy) and
	 * structured objects with exclusive/priority/timeout metadata.
	 * Plain strings are normalized to `{ name }` objects after parsing.
	 */
	hooks: z.array(z.union([z.enum(HOOK_NAMES), manifestHookEntrySchema])),
	/**
	 * Route declarations — accepts both plain name strings and
	 * structured objects with public metadata.
	 * Plain strings are normalized to `{ name }` objects after parsing.
	 */
	routes: z.array(
		z.union([
			z.string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
			manifestRouteEntrySchema,
		]),
	),
	admin: pluginAdminConfigSchema,
});

export type ValidatedPluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * Normalize a manifest hook entry — plain strings become `{ name }` objects.
 */
export function normalizeManifestHook(
	entry: string | { name: string; exclusive?: boolean; priority?: number; timeout?: number },
): { name: string; exclusive?: boolean; priority?: number; timeout?: number } {
	if (typeof entry === "string") {
		return { name: entry };
	}
	return entry;
}

/**
 * Normalize a manifest route entry — plain strings become `{ name }` objects.
 */
export function normalizeManifestRoute(entry: string | { name: string; public?: boolean }): {
	name: string;
	public?: boolean;
} {
	if (typeof entry === "string") {
		return { name: entry };
	}
	return entry;
}
