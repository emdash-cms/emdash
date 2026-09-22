import { z } from "zod";

import { httpUrl } from "./common.js";

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const importProbeBody = z.object({
	url: httpUrl,
});

export const wpPluginAnalyzeBody = z.object({
	url: httpUrl,
	token: z.string().min(1),
});

export const wpPluginExecuteBody = z.object({
	url: httpUrl,
	token: z.string().min(1),
	config: z.record(z.string(), z.unknown()),
	// --- Chunked mode (issue #475). Absent phase = single-shot legacy run. ---
	// The admin drives the import in a loop of bounded requests; cross-chunk
	// state travels with the client so the server stays stateless.
	phase: z.enum(["content", "comments", "finalize"]).optional(),
	/** Position within the phase: post-type index + WP page (content), page (comments) */
	cursor: z
		.object({
			postTypeIndex: z.number().int().min(0).default(0),
			page: z.number().int().min(1).default(1),
		})
		.optional(),
	/** WP post ID -> created EmDash item, accumulated across content chunks */
	idMap: z
		.record(z.string(), z.object({ id: z.string().min(1), collection: z.string().min(1) }))
		.optional(),
	/** Source translation group -> EmDash item ID, accumulated across content chunks */
	translationGroups: z.record(z.string(), z.string().min(1)).optional(),
	/** WP comment ID -> EmDash root comment ID, accumulated across comment chunks */
	commentRoots: z.record(z.string(), z.string().min(1)).optional(),
});

export const wpPrepareBody = z.object({
	postTypes: z.array(
		z.object({
			name: z.string().min(1),
			collection: z.string().min(1),
			fields: z
				.array(
					z.object({
						slug: z.string().min(1),
						label: z.string().min(1),
						type: z.string().min(1),
						required: z.boolean(),
						searchable: z.boolean().optional(),
					}),
				)
				.optional(),
		}),
	),
});

export const wpMediaImportBody = z.object({
	attachments: z.array(z.record(z.string(), z.unknown())),
	stream: z.boolean().optional(),
});

export const wpRewriteUrlsBody = z.object({
	urlMap: z.record(z.string(), z.string()),
	collections: z.array(z.string()).optional(),
});
