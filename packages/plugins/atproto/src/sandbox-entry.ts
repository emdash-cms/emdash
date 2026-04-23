/**
 * Sandbox Entry Point -- AT Protocol
 *
 * Canonical plugin implementation using the standard format.
 * The bundler (tsdown) inlines all local imports from atproto.ts,
 * bluesky.ts, and standard-site.ts into a single self-contained file.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { getAdminPageTarget, type AdminInteraction } from "./admin-routing.js";
import {
	ensureSession,
	createRecord,
	putRecord,
	deleteRecord,
	rkeyFromUri,
	uploadBlob,
	requireHttp,
	normalizePdsHost,
} from "./atproto.js";
import { buildBskyPost } from "./bluesky.js";
import { buildPublication, buildDocument } from "./standard-site.js";

// ── Types ───────────────────────────────────────────────────────

interface SyndicationRecord {
	collection: string;
	contentId: string;
	atUri: string;
	atCid: string;
	bskyPostUri?: string;
	bskyPostCid?: string;
	publishedAt: string;
	lastSyncedAt: string;
	status: "synced" | "error" | "pending";
	errorMessage?: string;
	retryCount?: number;
}

// ── Helpers ─────────────────────────────────────────────────────

async function isCollectionAllowed(ctx: PluginContext, collection: string): Promise<boolean> {
	const setting = await ctx.kv.get<string>("settings:collections");
	if (!setting || setting.trim() === "") return true;
	const allowed = setting.split(",").map((s: string) => s.trim().toLowerCase());
	return allowed.includes(collection.toLowerCase());
}

async function syndicateContent(
	ctx: PluginContext,
	collection: string,
	contentId: string,
	content: Record<string, unknown>,
): Promise<void> {
	const storageKey = `${collection}:${contentId}`;
	const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;

	if (existing && existing.status === "synced") {
		const syncOnUpdate = (await ctx.kv.get<boolean>("settings:syncOnUpdate")) ?? true;
		if (!syncOnUpdate) return;
	}

	const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
	if (!siteUrl) throw new Error("Site URL not configured");

	const publicationUri = await ctx.kv.get<string>("state:publicationUri");
	if (!publicationUri)
		throw new Error("Publication record not created yet. Use Sync Publication first.");

	const { accessJwt, did, pdsHost } = await ensureSession(ctx);

	// Upload cover image if present
	let coverImageBlob;
	const rawCoverImage = content.cover_image as string | undefined;
	if (rawCoverImage) {
		let imageUrl = rawCoverImage;
		if (imageUrl.startsWith("/")) imageUrl = `${siteUrl}${imageUrl}`;

		if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
			try {
				const http = requireHttp(ctx);
				const imageRes = await http.fetch(imageUrl);
				if (imageRes.ok) {
					const bytes = await imageRes.arrayBuffer();
					if (bytes.byteLength <= 1_000_000) {
						const mimeType = imageRes.headers.get("content-type") || "image/jpeg";
						coverImageBlob = await uploadBlob(ctx, pdsHost, accessJwt, bytes, mimeType);
					}
				}
			} catch (error) {
				ctx.log.warn("Failed to upload cover image, skipping", error);
			}
		}
	}

	let bskyPostRef: { uri: string; cid: string } | undefined;

	if (existing && existing.atUri) {
		const rkey = rkeyFromUri(existing.atUri);
		const doc = buildDocument({
			publicationUri,
			content,
			coverImageBlob,
			bskyPostRef:
				existing.bskyPostUri && existing.bskyPostCid
					? { uri: existing.bskyPostUri, cid: existing.bskyPostCid }
					: undefined,
		});

		const result = await putRecord(
			ctx,
			pdsHost,
			accessJwt,
			did,
			"site.standard.document",
			rkey,
			doc,
		);

		await ctx.storage.records!.put(storageKey, {
			collection: existing.collection,
			contentId: existing.contentId,
			atUri: result.uri,
			atCid: result.cid,
			bskyPostUri: existing.bskyPostUri,
			bskyPostCid: existing.bskyPostCid,
			publishedAt: existing.publishedAt,
			lastSyncedAt: new Date().toISOString(),
			status: "synced",
			retryCount: 0,
		} satisfies SyndicationRecord);

		ctx.log.info(`Updated AT Protocol document for ${collection}/${contentId}`);
	} else {
		const doc = buildDocument({ publicationUri, content, coverImageBlob });
		const result = await createRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", doc);

		const enableCrosspost = (await ctx.kv.get<boolean>("settings:enableBskyCrosspost")) ?? true;
		if (enableCrosspost) {
			try {
				const template =
					(await ctx.kv.get<string>("settings:crosspostTemplate")) || "{title}\n\n{url}";
				const langsStr = (await ctx.kv.get<string>("settings:langs")) || "en";
				const langs = langsStr
					.split(",")
					.map((s: string) => s.trim())
					.filter(Boolean)
					.slice(0, 3);
				const post = buildBskyPost({
					template,
					content,
					siteUrl,
					thumbBlob: coverImageBlob,
					langs,
				});

				const postResult = await createRecord(
					ctx,
					pdsHost,
					accessJwt,
					did,
					"app.bsky.feed.post",
					post,
				);
				bskyPostRef = { uri: postResult.uri, cid: postResult.cid };

				const rkey = rkeyFromUri(result.uri);
				const updatedDoc = buildDocument({ publicationUri, content, coverImageBlob, bskyPostRef });
				await putRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey, updatedDoc);

				ctx.log.info(`Cross-posted ${collection}/${contentId} to Bluesky`);
			} catch (error) {
				ctx.log.warn("Failed to cross-post to Bluesky, document still synced", error);
			}
		}

		await ctx.storage.records!.put(storageKey, {
			collection,
			contentId,
			atUri: result.uri,
			atCid: result.cid,
			bskyPostUri: bskyPostRef?.uri,
			bskyPostCid: bskyPostRef?.cid,
			publishedAt: (content.published_at as string) || new Date().toISOString(),
			lastSyncedAt: new Date().toISOString(),
			status: "synced",
		} satisfies SyndicationRecord);

		ctx.log.info(`Created AT Protocol document for ${collection}/${contentId}`);
	}
}

async function syncPublication(ctx: PluginContext) {
	const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
	const siteName = await ctx.kv.get<string>("settings:siteName");
	if (!siteUrl || !siteName)
		return {
			success: false,
			error: "Site URL and name are required",
		};

	const { accessJwt, did, pdsHost } = await ensureSession(ctx);
	const publication = buildPublication(siteUrl, siteName);
	const existingUri = await ctx.kv.get<string>("state:publicationUri");

	let result;
	if (existingUri) {
		const rkey = rkeyFromUri(existingUri);
		result = await putRecord(
			ctx,
			pdsHost,
			accessJwt,
			did,
			"site.standard.publication",
			rkey,
			publication,
		);
	} else {
		result = await createRecord(
			ctx,
			pdsHost,
			accessJwt,
			did,
			"site.standard.publication",
			publication,
		);
	}

	await ctx.kv.set("state:publicationUri", result.uri);
	await ctx.kv.set("state:publicationCid", result.cid);
	return {
		success: true,
		uri: result.uri,
		cid: result.cid,
	};
}

// ── Plugin definition ───────────────────────────────────────────

export default definePlugin({
	hooks: {
		"plugin:install": async (_event: unknown, ctx: PluginContext) => {
			ctx.log.info("AT Protocol plugin installed");
		},

		"content:afterSave": {
			handler: async (
				event: { content: Record<string, unknown>; collection: string; isNew: boolean },
				ctx: PluginContext,
			) => {
				const { content, collection } = event;
				const contentId = typeof content.id === "string" ? content.id : String(content.id);
				const status = content.status as string | undefined;

				if (status !== "published") return;
				if (!(await isCollectionAllowed(ctx, collection))) return;

				try {
					await syndicateContent(ctx, collection, contentId, content);
				} catch (error) {
					ctx.log.error(`Failed to syndicate ${collection}/${contentId}`, error);

					const storageKey = `${collection}:${contentId}`;
					const existing = await ctx.storage.records!.get(storageKey);
					const record = (existing as SyndicationRecord | null) || {
						collection,
						contentId,
						atUri: "",
						atCid: "",
						publishedAt: new Date().toISOString(),
					};

					await ctx.storage.records!.put(storageKey, {
						...record,
						status: "error",
						lastSyncedAt: new Date().toISOString(),
						errorMessage: error instanceof Error ? error.message : String(error),
						retryCount: ((record as SyndicationRecord).retryCount || 0) + 1,
					});
				}
			},
		},

		"content:afterDelete": {
			handler: async (event: { id: string; collection: string }, ctx: PluginContext) => {
				const { id, collection } = event;
				const deleteOnUnpublish = (await ctx.kv.get<boolean>("settings:deleteOnUnpublish")) ?? true;
				if (!deleteOnUnpublish) return;

				const storageKey = `${collection}:${id}`;
				const existing = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;
				if (!existing || !existing.atUri) return;

				try {
					const { accessJwt, did, pdsHost } = await ensureSession(ctx);
					const rkey = rkeyFromUri(existing.atUri);
					await deleteRecord(ctx, pdsHost, accessJwt, did, "site.standard.document", rkey);

					if (existing.bskyPostUri) {
						const postRkey = rkeyFromUri(existing.bskyPostUri);
						await deleteRecord(ctx, pdsHost, accessJwt, did, "app.bsky.feed.post", postRkey);
					}

					await ctx.storage.records!.delete(storageKey);
					ctx.log.info(`Deleted AT Protocol records for ${collection}/${id}`);
				} catch (error) {
					ctx.log.error(`Failed to delete AT Protocol records for ${collection}/${id}`, error);
				}
			},
		},

		"page:metadata": async (
			event: { page: { content?: { collection: string; id: string } } },
			ctx: PluginContext,
		) => {
			const pageContent = event.page.content;
			if (!pageContent) return null;

			const storageKey = `${pageContent.collection}:${pageContent.id}`;
			const record = (await ctx.storage.records!.get(storageKey)) as SyndicationRecord | null;

			if (!record || !record.atUri || record.status !== "synced") return null;

			return {
				kind: "link" as const,
				rel: "site.standard.document",
				href: record.atUri,
				key: "atproto-document",
			};
		},
	},

	routes: {
		status: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const handle = await ctx.kv.get<string>("settings:handle");
					const did = await ctx.kv.get<string>("state:did");
					const pubUri = await ctx.kv.get<string>("state:publicationUri");
					const synced = await ctx.storage.records!.count({
						status: "synced",
					});
					const errors = await ctx.storage.records!.count({
						status: "error",
					});
					const pending = await ctx.storage.records!.count({
						status: "pending",
					});

					return {
						configured: !!handle,
						connected: !!did,
						handle: handle || null,
						did: did || null,
						publicationUri: pubUri || null,
						stats: { synced, errors, pending },
					};
				} catch (error) {
					ctx.log.error("Failed to get status", error);
					return {
						configured: false,
						connected: false,
						handle: null,
						did: null,
						publicationUri: null,
						stats: { synced: 0, errors: 0, pending: 0 },
					};
				}
			},
		},

		"test-connection": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const session = await ensureSession(ctx);
					return {
						success: true,
						did: session.did,
						pdsHost: session.pdsHost,
					};
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		"sync-publication": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					return await syncPublication(ctx);
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		"recent-syncs": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				try {
					const result = await ctx.storage.records!.query({
						orderBy: { lastSyncedAt: "desc" },
						limit: 20,
					});
					return {
						items: result.items.map((item: { id: string; data: unknown }) => ({
							id: item.id,
							...(item.data as SyndicationRecord),
						})),
					};
				} catch (error) {
					ctx.log.error("Failed to get recent syncs", error);
					return { items: [] };
				}
			},
		},

		verification: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const pubUri = await ctx.kv.get<string>("state:publicationUri");
				const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
				return {
					publicationUri: pubUri || null,
					siteUrl: siteUrl || null,
					wellKnownPath: "/.well-known/site.standard.publication",
					wellKnownContent: pubUri || "(not configured yet)",
				};
			},
		},

		admin: {
			handler: async (routeCtx: any, ctx: PluginContext) => {
				const interaction = routeCtx.input as AdminInteraction | undefined;
				const interactionType = interaction?.type ?? "page_load";
				const pageTarget = getAdminPageTarget(interaction);

				if (pageTarget === "sync-widget") return buildSyncWidget(ctx);
				if (pageTarget === "status") return buildStatusPage(ctx);
				if (interactionType === "form_submit" && interaction?.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}
				if (interactionType === "block_action" && interaction?.action_id === "test_connection") {
					return testConnection(ctx);
				}
				if (interactionType === "block_action" && interaction?.action_id === "sync_publication") {
					return syncPublicationAdmin(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});

// ── Block Kit admin helpers ─────────────────────────────────────

async function buildSyncWidget(ctx: PluginContext) {
	try {
		const handle = await ctx.kv.get<string>("settings:handle");
		const did = await ctx.kv.get<string>("state:did");
		const synced = await ctx.storage.records!.count({ status: "synced" });
		const errors = await ctx.storage.records!.count({ status: "error" });

		if (!handle) {
			return {
				blocks: [
					{ type: "context", text: "Not configured -- set your handle in AT Protocol settings." },
				],
			};
		}

		return {
			blocks: [
				{
					type: "fields",
					fields: [
						{ label: "Handle", value: `@${handle}` },
						{ label: "Status", value: did ? "Connected" : "Not connected" },
						{ label: "Synced", value: String(synced) },
						{ label: "Errors", value: String(errors) },
					],
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build sync widget", error);
		return { blocks: [{ type: "context", text: "Failed to load status" }] };
	}
}

async function buildStatusPage(ctx: PluginContext) {
	try {
		const handle = await ctx.kv.get<string>("settings:handle");
		const appPassword = await ctx.kv.get<string>("settings:appPassword");
		const pdsHost = await ctx.kv.get<string>("settings:pdsHost");
		const siteUrl = await ctx.kv.get<string>("settings:siteUrl");
		const siteName = await ctx.kv.get<string>("settings:siteName");
		const enableBskyCrosspost =
			(await ctx.kv.get<boolean>("settings:enableBskyCrosspost")) ??
			(await ctx.kv.get<boolean>("settings:enableCrosspost"));
		const did = await ctx.kv.get<string>("state:did");
		const pubUri = await ctx.kv.get<string>("state:publicationUri");

		const blocks: unknown[] = [
			{ type: "header", text: "AT Protocol" },
			{
				type: "section",
				text: "Syndicate content to the AT Protocol network (Bluesky, standard.site).",
			},
			{ type: "divider" },
		];

		if (did) {
			blocks.push({
				type: "banner",
				style: "success",
				text: `Connected as ${handle} (${did})`,
			});
		} else if (handle) {
			blocks.push({
				type: "banner",
				style: "warning",
				text: "Handle configured but not yet connected. Save settings and test the connection.",
			});
		}

		blocks.push({
			type: "form",
			block_id: "atproto-settings",
			fields: [
				{
					type: "text_input",
					action_id: "handle",
					label: "AT Protocol Handle",
					initial_value: handle ?? "",
				},
				{ type: "secret_input", action_id: "appPassword", label: "App Password" },
				{
					type: "text_input",
					action_id: "pdsHost",
					label: "PDS Host",
					initial_value: pdsHost ?? "bsky.social",
				},
				{
					type: "text_input",
					action_id: "siteUrl",
					label: "Site URL",
					initial_value: siteUrl ?? "",
				},
				{
					type: "text_input",
					action_id: "siteName",
					label: "Site Name",
					initial_value: siteName ?? "",
				},
				{
					type: "toggle",
					action_id: "enableBskyCrosspost",
					label: "Cross-post to Bluesky",
					initial_value: enableBskyCrosspost ?? true,
				},
			],
			submit: { label: "Save Settings", action_id: "save_settings" },
		});

		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					label: "Test Connection",
					action_id: "test_connection",
					style: handle && appPassword ? "primary" : undefined,
				},
				{
					type: "button",
					label: pubUri ? "Update Publication" : "Sync Publication",
					action_id: "sync_publication",
					style: did && siteUrl && siteName ? "primary" : undefined,
				},
			],
		});

		if (did) {
			const result = await ctx.storage.records!.query({
				orderBy: { lastSyncedAt: "desc" },
				limit: 10,
			});
			const items = result.items.map((item: { id: string; data: unknown }) => ({
				id: item.id,
				...(item.data as SyndicationRecord),
			}));

			if (items.length > 0) {
				blocks.push(
					{ type: "divider" },
					{ type: "header", text: "Recent Syncs" },
					{
						type: "table",
						columns: [
							{ key: "collection", label: "Collection", format: "text" },
							{ key: "contentId", label: "Content", format: "code" },
							{ key: "status", label: "Status", format: "badge" },
							{ key: "lastSyncedAt", label: "Synced", format: "relative_time" },
						],
						rows: items.map((r: SyndicationRecord & { id: string }) => ({
							collection: r.collection,
							contentId: r.contentId,
							status: r.status,
							lastSyncedAt: r.lastSyncedAt,
						})),
						emptyText: "No syncs yet",
					},
				);
			}

			if (pubUri) {
				blocks.push(
					{ type: "divider" },
					{ type: "header", text: "Verification" },
					{
						type: "fields",
						fields: [
							{ label: "Publication URI", value: pubUri },
							{ label: "Well-known path", value: "/.well-known/site.standard.publication" },
						],
					},
					{
						type: "context",
						text: "Add this path to your site to verify ownership on the AT Protocol network.",
					},
				);
			}
		}

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build status page", error);
		return { blocks: [{ type: "banner", style: "error", text: "Failed to load settings" }] };
	}
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		if (typeof values.handle === "string") await ctx.kv.set("settings:handle", values.handle);
		if (typeof values.appPassword === "string" && values.appPassword)
			await ctx.kv.set("settings:appPassword", values.appPassword);
		if (typeof values.pdsHost === "string")
			await ctx.kv.set("settings:pdsHost", normalizePdsHost(values.pdsHost));
		if (typeof values.siteUrl === "string") await ctx.kv.set("settings:siteUrl", values.siteUrl);
		if (typeof values.siteName === "string") await ctx.kv.set("settings:siteName", values.siteName);
		if (typeof values.enableBskyCrosspost === "boolean")
			await ctx.kv.set("settings:enableBskyCrosspost", values.enableBskyCrosspost);
		if (typeof values.enableCrosspost === "boolean")
			await ctx.kv.set("settings:enableBskyCrosspost", values.enableCrosspost);

		const page = await buildStatusPage(ctx);
		return { ...page, toast: { message: "Settings saved", type: "success" } };
	} catch (error) {
		ctx.log.error("Failed to save settings", error);
		return {
			blocks: [{ type: "banner", style: "error", text: "Failed to save settings" }],
			toast: { message: "Failed to save settings", type: "error" },
		};
	}
}

async function testConnection(ctx: PluginContext) {
	try {
		const session = await ensureSession(ctx);
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: { message: `Connected to ${session.pdsHost} as ${session.did}`, type: "success" },
		};
	} catch (error) {
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				type: "error",
			},
		};
	}
}

async function syncPublicationAdmin(ctx: PluginContext) {
	try {
		const result = await syncPublication(ctx);
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: result.success
				? { message: "Publication synced", type: "success" }
				: { message: result.error ?? "Failed to sync publication", type: "error" },
		};
	} catch (error) {
		const page = await buildStatusPage(ctx);
		return {
			...page,
			toast: {
				message: `Publication sync failed: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
				type: "error",
			},
		};
	}
}
