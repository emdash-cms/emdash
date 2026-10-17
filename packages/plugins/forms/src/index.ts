/**
 * Forms Plugin for EmDash CMS
 *
 * Build forms in the admin, embed them in content via Portable Text,
 * accept submissions from anonymous visitors, send notifications, export data.
 *
 * This is a trusted plugin shipped as an npm package. It uses the standard
 * plugin APIs — nothing privileged.
 *
 * @example
 * ```typescript
 * // live.config.ts
 * import { formsPlugin } from "@emdash-cms/plugin-forms";
 *
 * export default defineConfig({
 *   plugins: [formsPlugin()],
 * });
 * ```
 */

import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { version } from "../package.json";
import { formIdFromDigestTask } from "./digest-task.js";
import { handleCleanup, handleDigest } from "./handlers/cron.js";
import {
	formsCreateHandler,
	formsDeleteHandler,
	formsDuplicateHandler,
	formsListHandler,
	formsUpdateHandler,
} from "./handlers/forms.js";
import {
	exportHandler,
	submissionDeleteHandler,
	submissionGetHandler,
	submissionsListHandler,
	submissionUpdateHandler,
} from "./handlers/submissions.js";
import { definitionHandler, submitHandler } from "./handlers/submit.js";
import {
	definitionSchema,
	exportSchema,
	formCreateSchema,
	formDeleteSchema,
	formDuplicateSchema,
	formsListSchema,
	formUpdateSchema,
	submissionDeleteSchema,
	submissionGetSchema,
	submissionsListSchema,
	submitSchema,
	submissionUpdateSchema,
} from "./schemas.js";
import { FORMS_STORAGE_CONFIG } from "./storage.js";

// ─── Plugin Options ──────────────────────────────────────────────

export interface FormsPluginOptions {
	/** Default spam protection for new forms */
	defaultSpamProtection?: "none" | "honeypot" | "turnstile";
}

// ─── Plugin Descriptor (for live.config.ts) ──────────────────────

export function formsPlugin(
	options: FormsPluginOptions = {},
): PluginDescriptor<FormsPluginOptions> {
	return {
		id: "emdash-forms",
		version,
		entrypoint: "@emdash-cms/plugin-forms",
		adminEntry: "@emdash-cms/plugin-forms/admin",
		componentsEntry: "@emdash-cms/plugin-forms/astro",
		options,
		capabilities: ["email:send", "media:write", "network:request"],
		allowedHosts: ["*"],
		adminPages: [
			{ path: "/", label: "Forms", icon: "list" },
			{ path: "/submissions", label: "Submissions", icon: "inbox" },
		],
		adminWidgets: [{ id: "recent-submissions", title: "Recent Submissions", size: "half" }],
		// Descriptor uses flat indexes only; composite indexes are in definePlugin
		storage: {
			forms: { indexes: ["status", "createdAt"], uniqueIndexes: ["slug"] },
			submissions: { indexes: ["formId", "status", "starred", "createdAt"] },
		},
	};
}

// ─── Plugin Implementation ───────────────────────────────────────

export function createPlugin(_options: FormsPluginOptions = {}): ResolvedPlugin {
	return definePlugin({
		id: "emdash-forms",
		version,
		capabilities: ["email:send", "media:write", "network:request"],
		allowedHosts: ["*"],

		storage: FORMS_STORAGE_CONFIG,

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					// Schedule weekly cleanup for expired submissions
					if (ctx.cron) {
						await ctx.cron.schedule("cleanup", { schedule: "@weekly" });
					}
				},
			},

			cron: {
				handler: async (event, ctx) => {
					if (event.name === "cleanup") {
						await handleCleanup(ctx);
					} else {
						const formId = formIdFromDigestTask(event.name);
						if (formId) await handleDigest(formId, ctx);
					}
				},
			},
		},

		routes: {
			// --- Public routes ---

			submit: {
				public: true,
				input: submitSchema,
				handler: submitHandler,
			},

			definition: {
				public: true,
				input: definitionSchema,
				handler: definitionHandler,
			},

			// --- Admin routes (require auth) ---

			// The four routes below are also offered as MCP tools (see `mcp` further
			// down). A tool can only bind to a route that names its permission, so
			// they state the default explicitly; REST access is unchanged.
			"forms/list": {
				permission: "plugins:manage",
				// A caller that sends no body at all still gets the first page.
				input: formsListSchema.prefault({}),
				handler: formsListHandler,
			},
			"forms/create": {
				input: formCreateSchema,
				handler: formsCreateHandler,
			},
			"forms/update": {
				input: formUpdateSchema,
				handler: formsUpdateHandler,
			},
			"forms/delete": {
				input: formDeleteSchema,
				handler: formsDeleteHandler,
			},
			"forms/duplicate": {
				input: formDuplicateSchema,
				handler: formsDuplicateHandler,
			},

			"submissions/list": {
				permission: "plugins:manage",
				input: submissionsListSchema,
				handler: submissionsListHandler,
			},
			"submissions/get": {
				permission: "plugins:manage",
				input: submissionGetSchema,
				handler: submissionGetHandler,
			},
			"submissions/update": {
				permission: "plugins:manage",
				input: submissionUpdateSchema,
				handler: submissionUpdateHandler,
			},
			"submissions/delete": {
				input: submissionDeleteSchema,
				handler: submissionDeleteHandler,
			},
			"submissions/export": {
				input: exportSchema,
				handler: exportHandler,
			},

			"settings/turnstile-status": {
				handler: async (ctx) => {
					const siteKey = await ctx.kv.get<string>("settings:turnstileSiteKey");
					const secretKey = await ctx.kv.get<string>("settings:turnstileSecretKey");
					return {
						hasSiteKey: !!siteKey,
						hasSecretKey: !!secretKey,
					};
				},
			},
		},

		// MCP tools: read forms and submissions, and triage a submission. Deleting
		// and exporting stay out on purpose, as do the form-editing routes. A site
		// admin enables these per plugin, and a token needs the plugin MCP scope;
		// without both, none of this is reachable.
		mcp: {
			tools: {
				forms_list: {
					description:
						"List the site's forms with their ids, slugs, names, fields and settings, newest first, up to 100 at a time; page with the returned cursor. Use a form's id with submissions_list.",
					route: "forms/list",
					input: formsListSchema,
					destructive: false,
				},
				submissions_list: {
					description:
						"List one form's submissions, newest first. Filter by status (new, read, archived) or starred; page with the returned cursor.",
					route: "submissions/list",
					input: submissionsListSchema,
					destructive: false,
				},
				submissions_get: {
					description: "Get one submission by id, with every field the visitor sent.",
					route: "submissions/get",
					input: submissionGetSchema,
					destructive: false,
				},
				submissions_update: {
					description:
						"Triage a submission: set its status (new, read, archived), star or unstar it, or set its notes. Does not change what the visitor sent.",
					route: "submissions/update",
					input: submissionUpdateSchema,
					destructive: false,
				},
			},
		},

		admin: {
			settingsSchema: {
				turnstileSiteKey: { type: "string", label: "Turnstile Site Key" },
				turnstileSecretKey: { type: "secret", label: "Turnstile Secret Key" },
			},
			pages: [
				{ path: "/", label: "Forms", icon: "list" },
				{ path: "/submissions", label: "Submissions", icon: "inbox" },
			],
			widgets: [{ id: "recent-submissions", title: "Recent Submissions", size: "half" }],
			portableTextBlocks: [
				{
					type: "emdash-form",
					label: "Form",
					icon: "form",
					description: "Embed a form",
					fields: [
						{
							type: "select",
							action_id: "formId",
							label: "Form",
							options: [],
							optionsRoute: "forms/list",
						},
					],
				},
			],
		},
	});
}

export default createPlugin;

// Re-export types for consumers
export type * from "./types.js";
export type { FormsStorage } from "./storage.js";
