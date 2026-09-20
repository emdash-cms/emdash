import type {
	BlockInteraction,
	BlockResponse,
	ContentEditorActionResponse,
	ContentEditorPanelInteraction,
} from "@emdash-cms/blocks/server";
import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { pluginManifestSchema, reconcileManifestAccess } from "@emdash-cms/plugin-types";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	CommentRepository,
	ContentRepository,
	MediaRepository,
	OptionsRepository,
	SCHEDULED_POLICY_REJECTION_PREFIX,
	RevisionRepository,
	pluginHttpResponseFromWire,
	pluginHttpResponseToWire,
	SchemaRegistry,
	UserRepository,
	definePlugin,
	type ContentItem,
	type CreateContentInput,
	type Database,
	type I18nConfig,
	type PluginManifest,
	type RedirectInfo,
	type RedirectStatus,
	type PluginHttpResponseWire,
	type SandboxOptions,
	type ScheduledPolicyRejection,
	type Storage,
	createContentAccess,
} from "emdash";
import { runMigrations } from "emdash/db";
import {
	BylineRepository,
	dispatchPluginApiRequest,
	dispatchPluginEditorExtensionApiRequest,
	EmDashRuntime,
	getI18nConfig,
	handlePluginSettingsUpdate,
	RedirectRepository,
	setI18nConfig,
	TaxonomyRepository,
	type UserInfo,
} from "emdash/plugin-test-runtime";
import { Kysely } from "kysely";

import type { PluginStorageTestEntry, PluginTestCollection, PluginTestRequest } from "./index.js";

interface RuntimeBindings {
	DB: D1Database;
	EMDASH_PLUGIN_CODE: string;
	EMDASH_PLUGIN_MANIFEST: string;
}

export interface PluginRuntimeTestHostOptions {
	site?: {
		name?: string;
		url?: string;
		locale?: string;
		trailingSlash?: "always" | "never" | "ignore";
	};
	i18n?: I18nConfig;
}

export interface PluginHttpTestRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Uint8Array;
}

export interface PluginRuntimeRouteRequest extends PluginTestRequest {
	body?: unknown;
	rawBody?: BodyInit;
	tokenScopes?: string[];
}

export interface PluginRuntimeMediaFixture {
	filename: string;
	mimeType: string;
	bytes: Uint8Array;
	status?: "pending" | "ready" | "failed";
	reportedSize?: number;
	width?: number;
	height?: number;
	alt?: string;
	caption?: string;
	contentHash?: string;
	blurhash?: string;
	dominantColor?: string;
	authorId?: string;
	folderId?: string | null;
}

export interface PluginRuntimeAdminRequestOptions {
	locale?: string;
	contentLocale?: string;
	user?: UserInfo;
}

export interface PluginRuntimeTestHost {
	readonly manifest: PluginManifest;
	transport: {
		invokeHook(name: string, event: unknown): Promise<unknown>;
		invokeRoute(name: string, input?: unknown, request?: PluginTestRequest): Promise<unknown>;
	};
	admin: {
		loadPage(path: string, options?: PluginRuntimeAdminRequestOptions): Promise<BlockResponse>;
		loadWidget(id: string, options?: PluginRuntimeAdminRequestOptions): Promise<BlockResponse>;
		act(
			page: string,
			actionId: string,
			options?: PluginRuntimeAdminRequestOptions & { blockId?: string; value?: unknown },
		): Promise<BlockResponse>;
		submit(
			page: string,
			actionId: string,
			values: Record<string, unknown>,
			options?: PluginRuntimeAdminRequestOptions & { blockId?: string },
		): Promise<BlockResponse>;
		loadEditorPanel(
			panelId: string,
			collection: string,
			entryId: string,
			options?: PluginRuntimeAdminRequestOptions,
		): Promise<BlockResponse>;
		actEditorPanel(
			panelId: string,
			collection: string,
			entryId: string,
			actionId: string,
			options?: PluginRuntimeAdminRequestOptions & { blockId?: string; value?: unknown },
		): Promise<BlockResponse>;
		submitEditorPanel(
			panelId: string,
			collection: string,
			entryId: string,
			actionId: string,
			values: Record<string, unknown>,
			options?: PluginRuntimeAdminRequestOptions & { blockId?: string },
		): Promise<BlockResponse>;
		invokeEditorAction(
			actionId: string,
			collection: string,
			entryId: string,
			options?: PluginRuntimeAdminRequestOptions,
		): Promise<ContentEditorActionResponse>;
	};
	fixtures: {
		site(input: {
			name?: string;
			url?: string;
			locale?: string;
			trailingSlash?: "always" | "never" | "ignore";
		}): Promise<void>;
		collection(input: PluginTestCollection): Promise<{ slug: string }>;
		user(input: {
			email: string;
			name?: string;
			role?: "subscriber" | "contributor" | "author" | "editor" | "admin";
			emailVerified?: boolean;
		}): Promise<UserInfo>;
		content(collection: string, input: Omit<CreateContentInput, "type">): Promise<ContentItem>;
		media(input: PluginRuntimeMediaFixture): Promise<{ id: string }>;
		comment(input: {
			collection: string;
			contentId: string;
			authorName: string;
			authorEmail: string;
			body: string;
			status?: "approved" | "pending" | "spam" | "trash";
			parentId?: string | null;
			ipHash?: string | null;
			userAgent?: string | null;
			moderationMetadata?: Record<string, unknown> | null;
		}): Promise<{ id: string }>;
		taxonomyDefinition(input: {
			name: string;
			label: string;
			labelSingular?: string;
			hierarchical?: boolean;
			collections: string[];
			locale?: string;
		}): Promise<{ id: string; name: string }>;
		redirect(input: {
			source: string;
			destination?: string;
			type?: RedirectStatus;
			enabled?: boolean;
			groupName?: string | null;
			auto?: boolean;
		}): Promise<RedirectInfo>;
		byline: BylineRepository["create"];
		taxonomy: TaxonomyRepository["create"];
		revision(
			collection: string,
			entryId: string,
			data: Record<string, unknown>,
			options?: { authorId?: string },
		): Promise<{ id: string }>;
		plugin: {
			setting(key: string, value: unknown): Promise<void>;
			kv(key: string, value: unknown): Promise<void>;
			storage(collection: string, id: string, value: unknown): Promise<void>;
		};
	};
	actions: {
		content: {
			create: EmDashRuntime["handleContentCreate"];
			update: EmDashRuntime["handleContentUpdate"];
			trash: EmDashRuntime["handleContentDelete"];
			delete: EmDashRuntime["handleContentPermanentDelete"];
			publish: EmDashRuntime["handleContentPublish"];
			unpublish: EmDashRuntime["handleContentUnpublish"];
			schedule: EmDashRuntime["handleContentSchedule"];
			unschedule: EmDashRuntime["handleContentUnschedule"];
			restore: EmDashRuntime["handleContentRestore"];
		};
		plugin: {
			activate(): Promise<void>;
			deactivate(): Promise<void>;
			updateSettings(
				values: Record<string, unknown>,
			): ReturnType<typeof handlePluginSettingsUpdate>;
		};
		media: { upload: EmDashRuntime["handleMediaUpload"] };
		comments: {
			submit(input: {
				collection: string;
				contentId: string;
				authorName: string;
				authorEmail: string;
				body: string;
				parentId?: string | null;
				website_url?: string;
				turnstileToken?: string;
				user?: UserInfo;
				headers?: HeadersInit;
			}): Promise<Response>;
			moderate(
				id: string,
				status: "pending" | "approved" | "spam" | "trash",
				moderator: UserInfo,
			): ReturnType<EmDashRuntime["handleCommentModerate"]>;
			moderateAsPlugin(
				id: string,
				status: "pending" | "approved" | "spam",
				expectedStatus: "pending" | "approved" | "spam",
			): ReturnType<EmDashRuntime["handlePluginCommentModerate"]>;
		};
		routes: { request(name: string, request?: PluginRuntimeRouteRequest): Promise<Response> };
	};
	inspect: {
		content: {
			get(collection: string, id: string): Promise<ContentItem | null>;
			list(collection: string): Promise<ContentItem[]>;
			publicUrl(collection: string, id: string): Promise<string | null>;
			bylines: BylineRepository["getContentBylines"];
			terms: TaxonomyRepository["getTermsForEntry"];
		};
		schema(): ReturnType<SchemaRegistry["listCollectionsWithFields"]>;
		storage: {
			get<T = unknown>(collection: string, id: string): Promise<T | null>;
			list<T = unknown>(collection: string): Promise<Array<PluginStorageTestEntry<T>>>;
		};
		kv: {
			get<T = unknown>(key: string): Promise<T | null>;
			list(): Promise<Array<PluginStorageTestEntry>>;
		};
		setting<T = unknown>(key: string): Promise<T | null>;
		settings: {
			raw<T = unknown>(key: string): Promise<T | null>;
		};
		pluginState(): Promise<Record<string, unknown> | null>;
		scheduledTasks(): Promise<Array<Record<string, unknown>>>;
		scheduledPolicyRejections(): Promise<ScheduledPolicyRejection[]>;
		media(id: string): ReturnType<EmDashRuntime["handleMediaGet"]>;
		mediaBytes(id: string): Promise<Uint8Array | null>;
		comments(): Promise<Array<Record<string, unknown>>>;
		redirects(): Promise<RedirectInfo[]>;
		email(): Promise<Array<Record<string, unknown>>>;
	};
	scheduled: {
		setTime(value: string | Date): void;
		run(): Promise<{ processed: number; published: Array<{ collection: string; id: string }> }>;
	};
	http: {
		respond(url: string, response: Response): Promise<void>;
		requests(): PluginHttpTestRequest[];
		clear(): void;
	};
	restart(): Promise<void>;
	dispose(): Promise<void>;
}

class MemoryStorage implements Storage {
	private files = new Map<string, { bytes: Uint8Array; contentType: string }>();

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}) {
		const bytes =
			options.body instanceof Uint8Array
				? new Uint8Array(options.body)
				: new Uint8Array(await new Response(options.body).arrayBuffer());
		this.files.set(options.key, { bytes, contentType: options.contentType });
		return { key: options.key, url: `memory://${options.key}`, size: bytes.byteLength };
	}

	async download(key: string) {
		const file = this.files.get(key);
		if (!file) throw new Error(`Missing test media: ${key}`);
		return {
			body: new Blob([file.bytes.slice().buffer]).stream(),
			contentType: file.contentType,
			size: file.bytes.byteLength,
		};
	}

	async delete(key: string): Promise<void> {
		this.files.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.files.has(key);
	}

	async list() {
		return { files: [], cursor: undefined };
	}

	async getSignedUploadUrl(options: { key: string; contentType: string }) {
		return {
			url: `memory://upload/${options.key}`,
			method: "PUT" as const,
			headers: { "Content-Type": options.contentType },
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
	}

	getPublicUrl(key: string): string {
		return `memory://${key}`;
	}

	clear(): void {
		this.files.clear();
	}
}

function isRuntimeBindings(value: unknown): value is RuntimeBindings {
	return (
		typeof value === "object" &&
		value !== null &&
		"DB" in value &&
		typeof value.DB === "object" &&
		value.DB !== null &&
		"prepare" in value.DB &&
		typeof value.DB.prepare === "function" &&
		"EMDASH_PLUGIN_CODE" in value &&
		typeof value.EMDASH_PLUGIN_CODE === "string" &&
		"EMDASH_PLUGIN_MANIFEST" in value &&
		typeof value.EMDASH_PLUGIN_MANIFEST === "string"
	);
}

function bindings(): RuntimeBindings {
	const value: unknown = env;
	if (!isRuntimeBindings(value)) {
		throw new Error(
			"EmDash plugin test bindings are unavailable; add emdashPluginTest() to Vitest",
		);
	}
	return value;
}

function redirectStatus(value: number): RedirectStatus {
	switch (value) {
		case 301:
		case 302:
		case 307:
		case 308:
		case 410:
		case 451:
			return value;
		default:
			throw new Error(`Invalid stored redirect status: ${value}`);
	}
}

export async function createPluginRuntimeTestHost(
	options: PluginRuntimeTestHostOptions = {},
): Promise<PluginRuntimeTestHost> {
	const bound = bindings();
	const parsed = pluginManifestSchema.safeParse(JSON.parse(bound.EMDASH_PLUGIN_MANIFEST));
	if (!parsed.success) throw new Error("EmDash plugin test manifest is invalid");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the shared wire schema validates the manifest before it crosses into core's equivalent runtime type
	const manifest = reconcileManifestAccess(parsed.data) as unknown as PluginManifest;
	const db = new Kysely<Database>({
		dialect: createDialect({ binding: "DB", session: "disabled" }),
	});
	await runMigrations(db);
	const optionRepo = new OptionsRepository(db);
	await optionRepo.set("emdash:setup_complete", true);
	await optionRepo.set("emdash:site_title", options.site?.name ?? "EmDash plugin test site");
	await optionRepo.set("emdash:site_url", options.site?.url ?? "https://plugin.test");
	await optionRepo.set(
		"emdash:locale",
		options.site?.locale ?? options.i18n?.defaultLocale ?? "en",
	);
	await optionRepo.set("emdash:exclusive_hook:email:deliver", "plugin-test-email-transport");

	const capturedEmail: Array<Record<string, unknown>> = [];
	const capturedHttpRequests: PluginHttpTestRequest[] = [];
	const httpResponses = new Map<string, PluginHttpResponseWire[]>();
	const httpFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});
		capturedHttpRequests.push({
			url: request.url,
			method: request.method,
			headers,
			body: new Uint8Array(await request.arrayBuffer()),
		});
		const responses = httpResponses.get(request.url);
		const response = responses?.shift();
		if (!response) throw new Error(`No plugin HTTP test response for ${request.url}`);
		if (responses?.length === 0) httpResponses.delete(request.url);
		return pluginHttpResponseFromWire(response);
	};
	const storage = new MemoryStorage();
	const siteInfo = { ...options.site };
	const previousI18n = getI18nConfig();
	setI18nConfig(options.i18n ?? null);
	let currentTime = new Date();
	let disposed = false;
	let isolateGeneration = 0;
	const entrypoint = `plugin-runtime-test-${crypto.randomUUID()}`;
	const entry = {
		id: manifest.id,
		version: manifest.version,
		options: {},
		code: bound.EMDASH_PLUGIN_CODE,
		capabilities: manifest.capabilities,
		allowedHosts: manifest.allowedHosts,
		storage: manifest.storage,
		hooks: manifest.hooks,
		routes: manifest.routes,
		settingsSchema: manifest.admin.settingsSchema,
		fieldWidgets: manifest.admin.fieldWidgets,
		adminPages: manifest.admin.pages,
		adminWidgets: manifest.admin.widgets,
		editorPanels: manifest.admin.editorPanels,
		editorActions: manifest.admin.editorActions,
	};
	const sandboxedPluginEntries = [entry];
	const emailTransport = definePlugin({
		id: "plugin-test-email-transport",
		version: "1.0.0",
		capabilities: ["hooks.email-transport:register"],
		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: async (event) => {
					capturedEmail.push({ ...event.message, source: event.source });
				},
			},
		},
	});
	const deps = {
		config: {
			database: { entrypoint, type: "sqlite" as const, config: { binding: "DB" } },
			storage: { entrypoint: `${entrypoint}-storage`, config: {} },
		},
		plugins: [emailTransport],
		createDialect: () => createDialect({ binding: "DB", session: "disabled" }),
		createStorage: () => storage,
		createScheduler: null,
		sandboxEnabled: true,
		sandboxedPluginEntries,
		createSandboxRunner: (runnerOptions: SandboxOptions) =>
			new CloudflareSandboxRunner({
				...runnerOptions,
				httpFetch,
				isolateKey: `${entrypoint}-${isolateGeneration++}`,
			}),
		now: () => new Date(currentTime),
		siteInfo,
	} satisfies Parameters<typeof EmDashRuntime.create>[0];

	let runtime = await EmDashRuntime.create(deps);
	let adminUserPromise: Promise<UserInfo> | undefined;
	const getAdminUser = () =>
		(adminUserPromise ??= new UserRepository(runtime.db)
			.create({
				email: `plugin-admin-${crypto.randomUUID()}@example.test`,
				name: "Plugin test admin",
				role: "admin",
			})
			.then((user) => ({
				id: user.id,
				email: user.email,
				name: user.name,
				role: user.role,
				createdAt: user.createdAt,
			})));
	const createRuntime = async (): Promise<void> => {
		runtime = await EmDashRuntime.create(deps);
	};

	const assertActive = () => {
		if (disposed) throw new Error("Plugin runtime test host has been disposed");
	};
	const readStorage = async <T>(collection: string, id?: string) => {
		assertActive();
		let query = runtime.db
			.selectFrom("_plugin_storage")
			.select(["id", "data"])
			.where("plugin_id", "=", manifest.id)
			.where("collection", "=", collection)
			.orderBy("created_at", "asc")
			.orderBy("id", "asc");
		if (id !== undefined) {
			query = query.where("id", "=", id);
		}
		const rows = await query.execute();
		return rows.map((row) => ({
			id: row.id,
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the caller supplies the expected JSON value type for this inspector
			data: JSON.parse(row.data) as T,
		}));
	};
	const invokeAdmin = async (
		interaction: BlockInteraction,
		adminOptions: PluginRuntimeAdminRequestOptions = {},
	): Promise<BlockResponse> => {
		assertActive();
		const headers = new Headers({
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		});
		if (adminOptions.locale) headers.set("Cookie", `emdash-locale=${adminOptions.locale}`);
		const response = await dispatchPluginApiRequest({
			runtime,
			pluginId: manifest.id,
			path: "/admin",
			request: new Request(`https://plugin.test/_emdash/api/plugins/${manifest.id}/admin`, {
				method: "POST",
				headers,
				body: JSON.stringify(interaction),
			}),
			user: adminOptions.user ?? (await getAdminUser()),
		});
		if (!response.ok) {
			throw new Error(`Plugin admin request failed (${response.status}): ${await response.text()}`);
		}
		const body: unknown = await response.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("data" in body) ||
			typeof body.data !== "object" ||
			body.data === null
		) {
			throw new Error("Plugin admin response did not contain Block Kit data");
		}
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the production route validates BlockResponse before returning a successful envelope
		return body.data as BlockResponse;
	};
	const invokeEditorExtension = async <T>(
		kind: "panel" | "action",
		extensionId: string,
		collection: string,
		entryId: string,
		input: ContentEditorPanelInteraction | Record<string, never>,
		adminOptions: PluginRuntimeAdminRequestOptions = {},
	): Promise<T> => {
		assertActive();
		const headers = new Headers({
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		});
		if (adminOptions.locale) headers.set("Cookie", `emdash-locale=${adminOptions.locale}`);
		const localeSearch = adminOptions.contentLocale
			? `?locale=${encodeURIComponent(adminOptions.contentLocale)}`
			: "";
		const response = await dispatchPluginEditorExtensionApiRequest({
			runtime,
			pluginId: manifest.id,
			kind,
			extensionId,
			collection,
			entryId,
			request: new Request(
				`https://plugin.test/_emdash/api/content/${collection}/${entryId}/plugin-extensions/${manifest.id}/${kind}/${extensionId}${localeSearch}`,
				{ method: "POST", headers, body: JSON.stringify(input) },
			),
			user: adminOptions.user ?? (await getAdminUser()),
		});
		if (!response.ok) {
			throw new Error(
				`Plugin editor ${kind} request failed (${response.status}): ${await response.text()}`,
			);
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null || !("data" in body)) {
			throw new Error("Plugin editor extension response did not contain data");
		}
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- production dispatch validates the response before returning success
		return body.data as T;
	};
	const host: PluginRuntimeTestHost = {
		get manifest() {
			return manifest;
		},
		transport: {
			invokeHook: (name, event) => {
				assertActive();
				const plugin = runtime.sandboxedPlugins.get(`${manifest.id}:${manifest.version}`);
				if (!plugin) throw new Error(`Plugin isolate is not loaded: ${manifest.id}`);
				return plugin.invokeHook(name, event);
			},
			invokeRoute: (name, input = {}, request = {}) => {
				assertActive();
				const plugin = runtime.sandboxedPlugins.get(`${manifest.id}:${manifest.version}`);
				if (!plugin) throw new Error(`Plugin isolate is not loaded: ${manifest.id}`);
				return plugin.invokeRoute(name, input, {
					url: request.url ?? `https://plugin.test/_emdash/api/plugins/${manifest.id}/${name}`,
					method: request.method ?? "POST",
					headers: request.headers ?? {},
					meta: request.meta ?? { ip: null, userAgent: null, referer: null, geo: null },
					user: request.user,
					ui: request.ui,
				});
			},
		},
		admin: {
			loadPage: (path, adminOptions) =>
				invokeAdmin({ type: "page_load", page: path }, adminOptions),
			loadWidget: (id, adminOptions) =>
				invokeAdmin({ type: "page_load", page: `widget:${id}` }, adminOptions),
			act: (page, actionId, adminOptions = {}) =>
				invokeAdmin(
					{
						type: "block_action",
						action_id: actionId,
						page,
						...(adminOptions.blockId !== undefined && { block_id: adminOptions.blockId }),
						...(adminOptions.value !== undefined && { value: adminOptions.value }),
					},
					adminOptions,
				),
			submit: (page, actionId, values, adminOptions = {}) =>
				invokeAdmin(
					{
						type: "form_submit",
						action_id: actionId,
						values,
						page,
						...(adminOptions.blockId !== undefined && { block_id: adminOptions.blockId }),
					},
					adminOptions,
				),
			loadEditorPanel: (panelId, collection, entryId, adminOptions) =>
				invokeEditorExtension<BlockResponse>(
					"panel",
					panelId,
					collection,
					entryId,
					{ type: "panel_load" },
					adminOptions,
				),
			actEditorPanel: (panelId, collection, entryId, actionId, adminOptions = {}) =>
				invokeEditorExtension<BlockResponse>(
					"panel",
					panelId,
					collection,
					entryId,
					{
						type: "block_action",
						action_id: actionId,
						...(adminOptions.blockId !== undefined && { block_id: adminOptions.blockId }),
						...(adminOptions.value !== undefined && { value: adminOptions.value }),
					},
					adminOptions,
				),
			submitEditorPanel: (panelId, collection, entryId, actionId, values, adminOptions = {}) =>
				invokeEditorExtension<BlockResponse>(
					"panel",
					panelId,
					collection,
					entryId,
					{
						type: "form_submit",
						action_id: actionId,
						values,
						...(adminOptions.blockId !== undefined && { block_id: adminOptions.blockId }),
					},
					adminOptions,
				),
			invokeEditorAction: (actionId, collection, entryId, adminOptions) =>
				invokeEditorExtension<ContentEditorActionResponse>(
					"action",
					actionId,
					collection,
					entryId,
					{},
					adminOptions,
				),
		},
		fixtures: {
			async site(input) {
				assertActive();
				if (input.name !== undefined) {
					siteInfo.name = input.name;
					await optionRepo.set("emdash:site_title", input.name);
				}
				if (input.url !== undefined) {
					siteInfo.url = input.url;
					await optionRepo.set("emdash:site_url", input.url);
				}
				if (input.locale !== undefined) {
					siteInfo.locale = input.locale;
					await optionRepo.set("emdash:locale", input.locale);
				}
				if (input.trailingSlash !== undefined) siteInfo.trailingSlash = input.trailingSlash;
				await runtime.shutdown();
				await createRuntime();
			},
			async collection({
				fields = [],
				commentsModeration,
				commentsClosedAfterDays,
				commentsAutoApproveUsers,
				...collection
			}) {
				assertActive();
				const registry = new SchemaRegistry(runtime.db);
				await registry.createCollection(collection);
				if (
					commentsModeration !== undefined ||
					commentsClosedAfterDays !== undefined ||
					commentsAutoApproveUsers !== undefined
				) {
					await registry.updateCollection(collection.slug, {
						commentsModeration,
						commentsClosedAfterDays,
						commentsAutoApproveUsers,
					});
				}
				for (const field of fields) await registry.createField(collection.slug, field);
				return { slug: collection.slug };
			},
			async user(input) {
				assertActive();
				const { emailVerified, ...userInput } = input;
				const user = await new UserRepository(runtime.db).create(userInput);
				if (emailVerified) {
					await runtime.db
						.updateTable("users")
						.set({ email_verified: 1 })
						.where("id", "=", user.id)
						.execute();
				}
				return {
					id: user.id,
					email: user.email,
					name: user.name,
					role: user.role,
					createdAt: user.createdAt,
				};
			},
			content(collection, input) {
				assertActive();
				return new ContentRepository(runtime.db).create({ ...input, type: collection });
			},
			async media(input) {
				assertActive();
				const extensionIndex = input.filename.lastIndexOf(".");
				const extension = extensionIndex > 0 ? input.filename.slice(extensionIndex) : "";
				const storageKey = `plugin-test/${crypto.randomUUID()}${extension}`;
				await storage.upload({
					key: storageKey,
					body: input.bytes,
					contentType: input.mimeType,
				});
				const item = await new MediaRepository(runtime.db).create({
					filename: input.filename,
					mimeType: input.mimeType,
					size: input.reportedSize ?? input.bytes.byteLength,
					storageKey,
					status: input.status ?? "ready",
					width: input.width,
					height: input.height,
					alt: input.alt,
					caption: input.caption,
					contentHash: input.contentHash,
					blurhash: input.blurhash,
					dominantColor: input.dominantColor,
					authorId: input.authorId,
					folderId: input.folderId,
				});
				return { id: item.id };
			},
			async comment(input) {
				assertActive();
				const comment = await new CommentRepository(runtime.db).create(input);
				return { id: comment.id };
			},
			async taxonomyDefinition(input) {
				assertActive();
				const locale = input.locale ?? "en";
				const existing = await runtime.db
					.selectFrom("_emdash_taxonomy_defs")
					.select("id")
					.where("name", "=", input.name)
					.where("locale", "=", locale)
					.executeTakeFirst();
				const id = existing?.id ?? crypto.randomUUID();
				await runtime.db
					.insertInto("_emdash_taxonomy_defs")
					.values({
						id,
						name: input.name,
						label: input.label,
						label_singular: input.labelSingular ?? null,
						hierarchical: input.hierarchical ? 1 : 0,
						collections: JSON.stringify(input.collections),
						locale,
						translation_group: id,
					})
					.onConflict((conflict) =>
						conflict.columns(["name", "locale"]).doUpdateSet({
							label: input.label,
							label_singular: input.labelSingular ?? null,
							hierarchical: input.hierarchical ? 1 : 0,
							collections: JSON.stringify(input.collections),
						}),
					)
					.execute();
				return { id, name: input.name };
			},
			async redirect(input) {
				assertActive();
				const redirect = await new RedirectRepository(runtime.db).create({
					source: input.source,
					destination: input.destination ?? "",
					type: input.type,
					enabled: input.enabled,
					groupName: input.groupName,
					auto: input.auto,
				});
				return { ...redirect, type: redirectStatus(redirect.type) };
			},
			byline: (input) => new BylineRepository(runtime.db).create(input),
			taxonomy: (input) => new TaxonomyRepository(runtime.db).create(input),
			async revision(collection, entryId, data, revisionOptions) {
				assertActive();
				return new RevisionRepository(runtime.db).create({
					collection,
					entryId,
					data,
					...(revisionOptions?.authorId ? { authorId: revisionOptions.authorId } : {}),
				});
			},
			plugin: {
				setting: (key, value) => optionRepo.set(`plugin:${manifest.id}:settings:${key}`, value),
				async storage(collection, id, value) {
					await bound.DB.prepare(
						"INSERT INTO _plugin_storage (plugin_id, collection, id, data) VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id, collection, id) DO UPDATE SET data = excluded.data",
					)
						.bind(manifest.id, collection, id, JSON.stringify(value))
						.run();
				},
				kv(key, value) {
					return this.storage("__kv", key, value);
				},
			},
		},
		actions: {
			content: {
				create: (...args) => runtime.handleContentCreate(...args),
				update: (...args) => runtime.handleContentUpdate(...args),
				trash: (...args) => runtime.handleContentDelete(...args),
				delete: (...args) => runtime.handleContentPermanentDelete(...args),
				publish: (...args) => runtime.handleContentPublish(...args),
				unpublish: (...args) => runtime.handleContentUnpublish(...args),
				schedule: (...args) => runtime.handleContentSchedule(...args),
				unschedule: (...args) => runtime.handleContentUnschedule(...args),
				restore: (...args) => runtime.handleContentRestore(...args),
			},
			plugin: {
				async activate() {
					const result = await runtime.handlePluginEnable(manifest.id);
					if (!result.success) throw new Error(result.error.message);
				},
				async deactivate() {
					const result = await runtime.handlePluginDisable(manifest.id);
					if (!result.success) throw new Error(result.error.message);
				},
				updateSettings: (values) =>
					handlePluginSettingsUpdate(
						runtime.db,
						manifest.id,
						manifest.admin.settingsSchema ?? {},
						values,
					),
			},
			media: { upload: (...args) => runtime.handleMediaUpload(...args) },
			comments: {
				async submit(input) {
					const { collection, contentId, user, headers: inputHeaders, ...body } = input;
					const headers = new Headers(inputHeaders);
					headers.set("Content-Type", "application/json");
					return runtime.handlePublicCommentSubmission(
						collection,
						contentId,
						new Request(`https://plugin.test/_emdash/api/comments/${collection}/${contentId}`, {
							method: "POST",
							headers,
							body: JSON.stringify(body),
						}),
						user,
					);
				},
				moderate: (id, status, moderator) =>
					runtime.handleCommentModerate(id, status, {
						id: moderator.id,
						name: moderator.name,
					}),
				moderateAsPlugin: (id, status, expectedStatus) =>
					runtime.handlePluginCommentModerate(manifest.id, id, status, expectedStatus),
			},
			routes: {
				request(name, request = {}) {
					assertActive();
					const headers = new Headers(request.headers);
					let body: BodyInit | undefined = request.rawBody;
					if (request.rawBody === undefined && request.body !== undefined) {
						headers.set("Content-Type", "application/json");
						body = JSON.stringify(request.body);
					}
					return dispatchPluginApiRequest({
						runtime,
						pluginId: manifest.id,
						path: `/${name}`,
						request: new Request(
							request.url ?? `https://plugin.test/_emdash/api/plugins/${manifest.id}/${name}`,
							{ method: request.method ?? "POST", headers, body },
						),
						user: request.user,
						tokenScopes: request.tokenScopes,
					});
				},
			},
		},
		inspect: {
			content: {
				get: (collection, id) =>
					new ContentRepository(runtime.db).findByIdIncludingTrashed(collection, id),
				async list(collection) {
					const repo = new ContentRepository(runtime.db);
					const items: ContentItem[] = [];
					let cursor: string | undefined;
					do {
						const result = await repo.findMany(collection, { limit: 100, cursor });
						items.push(...result.items);
						cursor = result.nextCursor;
					} while (cursor);
					return items;
				},
				publicUrl: (collection, id) =>
					createContentAccess(runtime.db, {
						site: {
							name: siteInfo.name ?? "EmDash plugin test site",
							url: siteInfo.url ?? "https://plugin.test",
							locale: siteInfo.locale ?? "en",
							trailingSlash: siteInfo.trailingSlash,
						},
					}).getPublicUrl!(collection, id),
				bylines: (collection, id, bylineOptions) =>
					new BylineRepository(runtime.db).getContentBylines(collection, id, bylineOptions),
				terms: (collection, id, taxonomy, locale) =>
					new TaxonomyRepository(runtime.db).getTermsForEntry(collection, id, taxonomy, locale),
			},
			schema: () => new SchemaRegistry(runtime.db).listCollectionsWithFields(),
			storage: {
				async get<T>(collection: string, id: string) {
					return (await readStorage<T>(collection, id))[0]?.data ?? null;
				},
				list: readStorage,
			},
			kv: {
				async get<T>(key: string) {
					return (await readStorage<T>("__kv", key))[0]?.data ?? null;
				},
				list: () => readStorage("__kv"),
			},
			setting: (key) => optionRepo.get(`plugin:${manifest.id}:settings:${key}`),
			settings: {
				raw: (key) => optionRepo.get(`plugin:${manifest.id}:settings:${key}`),
			},
			async pluginState() {
				const state = await runtime.db
					.selectFrom("_plugin_state")
					.select(["plugin_id as pluginId", "version", "status", "source"])
					.where("plugin_id", "=", manifest.id)
					.executeTakeFirst();
				return state ?? null;
			},
			async scheduledTasks() {
				return runtime.db
					.selectFrom("_emdash_cron_tasks")
					.select([
						"task_name as name",
						"schedule",
						"next_run_at as nextRunAt",
						"status",
						"enabled",
					])
					.where("plugin_id", "=", manifest.id)
					.orderBy("next_run_at", "asc")
					.execute();
			},
			async scheduledPolicyRejections() {
				return [
					...(
						await optionRepo.getByPrefix<ScheduledPolicyRejection>(
							SCHEDULED_POLICY_REJECTION_PREFIX,
						)
					).values(),
				];
			},
			media: (id) => runtime.handleMediaGet(id),
			async mediaBytes(id) {
				const item = await new MediaRepository(runtime.db).findById(id);
				if (!item) return null;
				const downloaded = await storage.download(item.storageKey);
				return new Uint8Array(await new Response(downloaded.body).arrayBuffer());
			},
			async comments() {
				const rows = await bound.DB.prepare(
					"SELECT id, collection, content_id AS contentId, body, status FROM _emdash_comments ORDER BY created_at ASC",
				).all();
				return rows.results ?? [];
			},
			async redirects() {
				const rows = await runtime.db
					.selectFrom("_emdash_redirects")
					.selectAll()
					.orderBy("created_at", "asc")
					.orderBy("id", "asc")
					.execute();
				return rows.map(
					(row): RedirectInfo => ({
						id: row.id,
						source: row.source,
						destination: row.destination,
						type: redirectStatus(row.type),
						isPattern: row.is_pattern === 1,
						enabled: row.enabled === 1,
						hits: row.hits,
						lastHitAt: row.last_hit_at,
						groupName: row.group_name,
						auto: row.auto === 1,
						createdAt: row.created_at,
						updatedAt: row.updated_at,
					}),
				);
			},
			email: async () => capturedEmail.map((message) => ({ ...message })),
		},
		scheduled: {
			setTime(value) {
				const next = new Date(value);
				if (Number.isNaN(next.getTime())) throw new Error("Invalid scheduled test time");
				currentTime = next;
			},
			async run() {
				return runtime.runScheduledTasksWithStats();
			},
		},
		http: {
			async respond(url, response) {
				assertActive();
				const responses = httpResponses.get(url) ?? [];
				responses.push(await pluginHttpResponseToWire(response, url, false));
				httpResponses.set(url, responses);
			},
			requests() {
				assertActive();
				return capturedHttpRequests.map((request) => ({
					...request,
					headers: { ...request.headers },
					body: request.body.slice(),
				}));
			},
			clear() {
				assertActive();
				capturedHttpRequests.length = 0;
				httpResponses.clear();
			},
		},
		async restart() {
			assertActive();
			await runtime.shutdown();
			await createRuntime();
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await runtime.shutdown();
			await runtime.db.destroy();
			storage.clear();
			setI18nConfig(previousI18n);
			await db.destroy();
			await reset();
		},
	};
	return host;
}
