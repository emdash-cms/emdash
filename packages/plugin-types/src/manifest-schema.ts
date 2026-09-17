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

import { capabilitiesToDeclaredAccess, declaredAccessToCapabilities } from "./index.js";
import type { PluginManifest } from "./index.js";

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
	dependencies: z.array(z.string().min(1)).optional(),
	errorPolicy: z.enum(["continue", "abort"]).optional(),
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
	permission: z.string().min(1).optional(),
	cacheControl: z.string().min(1).optional(),
});

const pluginJsonSchema = z.record(z.string(), z.unknown());

const pluginMcpConfigSchema = z.object({
	tools: z.array(
		z.object({
			name: z.string().min(1),
			description: z.string().min(1),
			route: z.string().min(1),
			permission: z.string().min(1),
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

const editorExtensionIdPattern = /^[a-z][a-z0-9_-]*$/;
const collectionSlugPattern = /^[a-z][a-z0-9_]*$/;
const editorCollectionsSchema = z
	.array(z.string().max(63).regex(collectionSlugPattern, "Invalid collection slug"))
	.max(64)
	.refine((collections) => new Set(collections).size === collections.length, {
		message: "Editor extension collections must be unique",
	});
const editorPanelSchema = z.object({
	id: z.string().min(1).max(64).regex(editorExtensionIdPattern, "Invalid editor panel id"),
	title: z.string().min(1).max(128),
	route: z
		.string()
		.min(1)
		.max(128)
		.regex(routeNamePattern, "Route name must be a safe path segment"),
	collections: editorCollectionsSchema.optional(),
	order: z.number().int().min(-1_000).max(1_000).optional(),
});
const editorActionConfirmSchema = z.object({
	title: z.string().min(1).max(128),
	text: z.string().min(1).max(1_024),
	confirm: z.string().min(1).max(64),
	deny: z.string().min(1).max(64),
	style: z.literal("danger").optional(),
});
const editorActionSchema = z
	.object({
		id: z.string().min(1).max(64).regex(editorExtensionIdPattern, "Invalid editor action id"),
		label: z.string().min(1).max(128),
		route: z
			.string()
			.min(1)
			.max(128)
			.regex(routeNamePattern, "Route name must be a safe path segment"),
		placement: z.enum(["toolbar", "overflow"]),
		collections: editorCollectionsSchema.optional(),
		style: z.enum(["default", "danger"]).optional(),
		confirm: editorActionConfirmSchema.optional(),
	})
	.refine((action) => action.style !== "danger" || action.confirm !== undefined, {
		message: "Danger editor actions require confirmation",
		path: ["confirm"],
	});

function uniqueExtensionIds(
	items: readonly { id: string }[] | undefined,
	ctx: z.RefinementCtx,
	path: "editorPanels" | "editorActions",
): void {
	const seen = new Set<string>();
	for (const [index, item] of (items ?? []).entries()) {
		if (seen.has(item.id)) {
			ctx.addIssue({ code: "custom", message: `Duplicate ${path} id`, path: [path, index, "id"] });
		}
		seen.add(item.id);
	}
}

const pluginAdminConfigSchema = z
	.object({
		entry: z.string().optional(),
		settingsSchema: z.record(z.string(), settingFieldSchema).optional(),
		pages: z.array(adminPageSchema).optional(),
		widgets: z.array(dashboardWidgetSchema).optional(),
		editorPanels: z.array(editorPanelSchema).max(32).optional(),
		editorActions: z.array(editorActionSchema).max(32).optional(),
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
								.loose(),
						)
						.optional(),
				}),
			)
			.optional(),
	})
	.superRefine((admin, ctx) => {
		uniqueExtensionIds(admin.editorPanels, ctx, "editorPanels");
		uniqueExtensionIds(admin.editorActions, ctx, "editorActions");
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
export const pluginManifestBaseSchema = z.object({
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

function validateEditorExtensionRoutes(
	manifest: z.infer<typeof pluginManifestBaseSchema>,
	ctx: z.RefinementCtx,
): void {
	for (const [kind, extensions] of [
		["editorPanels", manifest.admin.editorPanels],
		["editorActions", manifest.admin.editorActions],
	] as const) {
		for (const [index, extension] of (extensions ?? []).entries()) {
			const matches = manifest.routes.filter(
				(route) => (typeof route === "string" ? route : route.name) === extension.route,
			);
			if (matches.length !== 1) {
				ctx.addIssue({
					code: "custom",
					message:
						matches.length === 0
							? "Editor extension route is not declared"
							: "Editor extension route must be declared exactly once",
					path: ["admin", kind, index, "route"],
				});
				continue;
			}
			const route = matches[0];
			if (!route) continue;
			if (typeof route !== "string" && route.public === true) {
				ctx.addIssue({
					code: "custom",
					message: "Editor extension routes must be private",
					path: ["admin", kind, index, "route"],
				});
			}
		}
	}
}

export const pluginManifestSchema = pluginManifestBaseSchema.superRefine(
	validateEditorExtensionRoutes,
);

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
	return reconciled;
}

/**
 * Normalize a manifest hook entry — plain strings become `{ name }` objects.
 */
export function normalizeManifestHook(
	entry:
		| string
		| {
				name: string;
				exclusive?: boolean;
				priority?: number;
				timeout?: number;
				dependencies?: string[];
				errorPolicy?: "continue" | "abort";
		  },
): {
	name: string;
	exclusive?: boolean;
	priority?: number;
	timeout?: number;
	dependencies?: string[];
	errorPolicy?: "continue" | "abort";
} {
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
