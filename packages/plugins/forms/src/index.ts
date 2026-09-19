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
					} else if (event.name.startsWith("digest:")) {
						const formId = event.name.slice("digest:".length);
						await handleDigest(formId, ctx);
					}
				},
			},
		},

		// Route handlers are typed with specific input schemas but the route record
		// erases the generic to `unknown`. The cast is safe because the input schema
		// guarantees the runtime shape matches the handler's expected type.
		routes: {
			// --- Public routes ---

			submit: {
				public: true,
				input: submitSchema,
				handler: submitHandler as never,
			},

			definition: {
				public: true,
				input: definitionSchema,
				handler: definitionHandler as never,
			},

			// --- Admin routes (require auth) ---

			"forms/list": {
				permission: "plugins:manage",
				input: formsListSchema,
				handler: formsListHandler,
			},
			"forms/create": {
				permission: "plugins:manage",
				input: formCreateSchema,
				handler: formsCreateHandler as never,
			},
			"forms/update": {
				permission: "plugins:manage",
				input: formUpdateSchema,
				handler: formsUpdateHandler as never,
			},
			"forms/delete": {
				permission: "plugins:manage",
				input: formDeleteSchema,
				handler: formsDeleteHandler as never,
			},
			"forms/duplicate": {
				permission: "plugins:manage",
				input: formDuplicateSchema,
				handler: formsDuplicateHandler as never,
			},

			"submissions/list": {
				permission: "plugins:manage",
				input: submissionsListSchema,
				handler: submissionsListHandler as never,
			},
			"submissions/get": {
				permission: "plugins:manage",
				input: submissionGetSchema,
				handler: submissionGetHandler as never,
			},
			"submissions/update": {
				permission: "plugins:manage",
				input: submissionUpdateSchema,
				handler: submissionUpdateHandler as never,
			},
			"submissions/delete": {
				permission: "plugins:manage",
				input: submissionDeleteSchema,
				handler: submissionDeleteHandler as never,
			},
			"submissions/export": {
				permission: "plugins:manage",
				input: exportSchema,
				handler: exportHandler as never,
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

		mcp: {
			tools: {
				listForms: {
					description: "List forms with their status and submission counts.",
					route: "forms/list",
					input: formsListSchema,
					destructive: false,
				},
				createForm: {
					description: "Create a form with pages, fields, and settings.",
					route: "forms/create",
					input: formCreateSchema,
					destructive: false,
				},
				updateForm: {
					description: "Update an existing form's definition, settings, or status.",
					route: "forms/update",
					input: formUpdateSchema,
					destructive: true,
				},
				deleteForm: {
					description: "Delete a form and optionally its submissions.",
					route: "forms/delete",
					input: formDeleteSchema,
					destructive: true,
				},
				duplicateForm: {
					description: "Duplicate an existing form with an optional new name or slug.",
					route: "forms/duplicate",
					input: formDuplicateSchema,
					destructive: false,
				},
				listSubmissions: {
					description:
						"List submissions for a form, optionally filtered by status or starred state.",
					route: "submissions/list",
					input: submissionsListSchema,
					destructive: false,
				},
				getSubmission: {
					description: "Get a single form submission by ID.",
					route: "submissions/get",
					input: submissionGetSchema,
					destructive: false,
				},
				updateSubmission: {
					description: "Update a submission's status, starred state, or notes.",
					route: "submissions/update",
					input: submissionUpdateSchema,
					destructive: true,
				},
				deleteSubmission: {
					description: "Permanently delete a form submission and its uploaded files.",
					route: "submissions/delete",
					input: submissionDeleteSchema,
					destructive: true,
				},
				exportSubmissions: {
					description: "Export filtered submissions for a form as CSV or JSON.",
					route: "submissions/export",
					input: exportSchema,
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
