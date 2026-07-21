/**
 * Zod schema for PluginManifest validation
 *
 * Used to validate manifest.json from plugin bundles at every parse site:
 * - Client-side download (marketplace.ts extractBundle)
 * - R2 load (api/handlers/marketplace.ts loadBundleFromR2)
 * - CLI publish preview (cli/commands/publish.ts readManifestFromTarball)
 * - Marketplace ingest extends this with publishing-specific fields
 */

import { Permissions } from "@emdash-cms/auth";
import {
	capabilitiesToDeclaredAccess,
	declaredAccessToCapabilities,
} from "@emdash-cms/plugin-types";
import { z } from "zod";

import type { PluginManifest } from "./types.js";

// ── Enum values (must stay in sync with types.ts) ───────────────

/**
 * Current capability names — the ones authors should use going forward.
 * See `PluginCapability` in `types.ts` for documentation of each.
 */
export const CURRENT_PLUGIN_CAPABILITIES = [
	"network:request",
	"network:request:unrestricted",
	"content:read",
	"content:write",
	"taxonomies:read",
	"media:read",
	"media:write",
	"users:read",
	"email:send",
	"hooks.email-transport:register",
	"hooks.email-events:register",
	"hooks.page-fragments:register",
] as const;

/**
 * Legacy capability names accepted during the deprecation window.
 * Normalized to current names via `normalizeCapability()` in types.ts
 * before reaching the runtime. Plugin authors are warned at bundle/validate
 * and hard-failed at publish.
 */
export const DEPRECATED_PLUGIN_CAPABILITIES = [
	"network:fetch",
	"network:fetch:any",
	"read:content",
	"write:content",
	"read:media",
	"write:media",
	"read:users",
	"email:provide",
	"email:intercept",
	"page:inject",
] as const;

/**
 * Full set of accepted capability strings — current + deprecated.
 *
 * The manifest schema accepts both during the transition. The runtime only
 * ever sees current names because `normalizeCapability()` rewrites legacy
 * names at every external boundary (definePlugin, adaptSandboxEntry).
 */
export const PLUGIN_CAPABILITIES = [
	...CURRENT_PLUGIN_CAPABILITIES,
	...DEPRECATED_PLUGIN_CAPABILITIES,
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
	"content:afterRestore",
	"content:afterSchedule",
	"content:afterUnschedule",
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
	permission: z
		.string()
		.refine((permission) => permission in Permissions)
		.optional(),
	cacheControl: z.string().min(1).optional(),
});

const pluginJsonSchema = z.record(z.string(), z.unknown());
const mcpToolNamePattern = /^[a-zA-Z0-9_-]+$/;
const pluginMcpConfigSchema = z.object({
	tools: z.array(
		z.object({
			name: z.string().min(1).max(64).regex(mcpToolNamePattern, "Invalid MCP tool name"),
			description: z.string().min(1),
			route: z.string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
			permission: z.string().refine((permission) => permission in Permissions),
			destructive: z.boolean(),
			inputSchema: pluginJsonSchema,
			outputSchema: pluginJsonSchema.optional(),
		}),
	),
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
	z.object({
		...baseSettingFields,
		type: z.literal("url"),
		default: z.string().optional(),
		placeholder: z.string().optional(),
	}),
	z.object({
		...baseSettingFields,
		type: z.literal("email"),
		default: z.string().optional(),
		placeholder: z.string().optional(),
	}),
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

// ── declaredAccess ──────────────────────────────────────────────

/**
 * An operation's constraint object. Open vocabulary: keys the runtime
 * recognises are enforced, others are advisory. The bundler emits `{}` for a
 * granted operation; presence (not value) signals the grant.
 */
const accessConstraints = z.record(z.string(), z.unknown());

/**
 * Structured trust contract embedded in the bundle manifest. Mirrors
 * `DeclaredAccess` in `@emdash-cms/plugin-types`. Categories are host
 * subsystems; operations are modes of participation.
 */
const declaredAccessSchema = z.object({
	content: z
		.object({ read: accessConstraints.optional(), write: accessConstraints.optional() })
		.optional(),
	taxonomies: z.object({ read: accessConstraints.optional() }).optional(),
	media: z
		.object({ read: accessConstraints.optional(), write: accessConstraints.optional() })
		.optional(),
	network: z
		.object({
			// allowedHosts: absent = unrestricted; present = host-restricted. Reject
			// an empty array (which the decoder would otherwise have to treat as
			// deny-all) to match the record lexicon's `minLength: 1` and keep the
			// "absent vs empty" distinction from ever reaching enforcement ambiguous.
			request: z.object({ allowedHosts: z.array(z.string()).min(1).optional() }).optional(),
		})
		.optional(),
	email: z
		.object({
			send: accessConstraints.optional(),
			events: accessConstraints.optional(),
			transport: accessConstraints.optional(),
		})
		.optional(),
	page: z.object({ fragments: accessConstraints.optional() }).optional(),
	users: z.object({ read: accessConstraints.optional() }).optional(),
});

// ── Main schema ─────────────────────────────────────────────────

/**
 * Zod schema matching the PluginManifest interface from types.ts.
 *
 * Every JSON.parse of a manifest.json should validate through this.
 *
 * `declaredAccess` is the trust contract; `capabilities`/`allowedHosts` are the
 * runtime's enforcement currency. Apply `reconcileManifestAccess` after parsing
 * to make them consistent (declaredAccess authoritative when present). Kept a
 * plain object (no `.transform`) because callers `.pick()`/`.extend()` it.
 */
export const pluginManifestSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1),
	declaredAccess: declaredAccessSchema.optional(),
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
	mcp: pluginMcpConfigSchema.optional(),
	admin: pluginAdminConfigSchema,
});

export type ValidatedPluginManifest = z.infer<typeof pluginManifestSchema>;

/**
 * Reconcile a parsed manifest's trust contract with its enforcement currency.
 * `declaredAccess` is authoritative: when present, `capabilities`/`allowedHosts`
 * are re-derived from it so what the runtime enforces always matches what was
 * recorded and consented to. A pre-migration bundle without `declaredAccess`
 * has it derived from the legacy capability list instead. The result always
 * carries both, mutually consistent. Apply this at every bundle-parse site.
 */
export function reconcileManifestAccess(manifest: ValidatedPluginManifest): PluginManifest {
	const reconciled: ValidatedPluginManifest = manifest.declaredAccess
		? { ...manifest, ...declaredAccessToCapabilities(manifest.declaredAccess) }
		: {
				...manifest,
				declaredAccess: capabilitiesToDeclaredAccess(manifest.capabilities, manifest.allowedHosts),
			};
	// Block Kit admin elements are typed as `unknown` by the Zod schema (their
	// Element shape is validated at render time), so the validated manifest
	// needs a structural cast up to the runtime PluginManifest.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- admin elements are unknown[] in Zod; Element type checked at render time
	return reconciled as unknown as PluginManifest;
}

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
export function normalizeManifestRoute(
	entry: string | { name: string; public?: boolean; permission?: string; cacheControl?: string },
): {
	name: string;
	public?: boolean;
	permission?: string;
	cacheControl?: string;
} {
	if (typeof entry === "string") {
		return { name: entry };
	}
	return entry;
}
