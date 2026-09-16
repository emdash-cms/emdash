import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { pluginManifestSchema } from "@emdash-cms/plugin-types";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	ContentRepository,
	OptionsRepository,
	SchemaRegistry,
	UserRepository,
	definePlugin,
	type ContentItem,
	type CreateContentInput,
	type Database,
	type I18nConfig,
	type PluginManifest,
	type SandboxOptions,
	type Storage,
} from "emdash";
import { runMigrations } from "emdash/db";
import {
	dispatchPluginApiRequest,
	EmDashRuntime,
	getI18nConfig,
	setI18nConfig,
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

export interface PluginRuntimeRouteRequest extends PluginTestRequest {
	body?: unknown;
	tokenScopes?: string[];
}

export interface PluginRuntimeTestHost {
	readonly manifest: PluginManifest;
	transport: {
		invokeHook(name: string, event: unknown): Promise<unknown>;
		invokeRoute(name: string, input?: unknown, request?: PluginTestRequest): Promise<unknown>;
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
		}): Promise<UserInfo>;
		content(collection: string, input: Omit<CreateContentInput, "type">): Promise<ContentItem>;
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
			install(): Promise<void>;
			activate(): Promise<void>;
			deactivate(): Promise<void>;
			update(version: string): Promise<void>;
			uninstall(deleteData?: boolean): Promise<void>;
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
			}): ReturnType<EmDashRuntime["handleCommentCreate"]>;
			moderate(
				id: string,
				status: "pending" | "approved" | "spam" | "trash",
				moderator: UserInfo,
			): ReturnType<EmDashRuntime["handleCommentModerate"]>;
		};
		routes: { request(name: string, request?: PluginRuntimeRouteRequest): Promise<Response> };
	};
	inspect: {
		content: {
			get(collection: string, id: string): Promise<ContentItem | null>;
			list(collection: string): Promise<ContentItem[]>;
		};
		storage: {
			get<T = unknown>(collection: string, id: string): Promise<T | null>;
			list<T = unknown>(collection: string): Promise<Array<PluginStorageTestEntry<T>>>;
		};
		kv: {
			get<T = unknown>(key: string): Promise<T | null>;
			list(): Promise<Array<PluginStorageTestEntry>>;
		};
		setting<T = unknown>(key: string): Promise<T | null>;
		pluginState(): Promise<Record<string, unknown> | null>;
		scheduledTasks(): Promise<Array<Record<string, unknown>>>;
		media(id: string): ReturnType<EmDashRuntime["handleMediaGet"]>;
		comments(): Promise<Array<Record<string, unknown>>>;
		email(): Promise<Array<Record<string, unknown>>>;
	};
	scheduled: {
		setTime(value: string | Date): void;
		run(): Promise<{ processed: number; published: Array<{ collection: string; id: string }> }>;
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

function parseCommentModeration(value: string): "all" | "first_time" | "none" {
	if (value === "all" || value === "first_time" || value === "none") return value;
	throw new Error(`Invalid comment moderation mode: ${value}`);
}

export async function createPluginRuntimeTestHost(
	options: PluginRuntimeTestHostOptions = {},
): Promise<PluginRuntimeTestHost> {
	const bound = bindings();
	const parsed = pluginManifestSchema.safeParse(JSON.parse(bound.EMDASH_PLUGIN_MANIFEST));
	if (!parsed.success) throw new Error("EmDash plugin test manifest is invalid");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the shared wire schema validates the manifest before it crosses into core's equivalent runtime type
	const manifest = parsed.data as unknown as PluginManifest;
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
	const storage = new MemoryStorage();
	const siteInfo = { ...options.site };
	const previousI18n = getI18nConfig();
	setI18nConfig(options.i18n ?? null);
	let currentTime = new Date();
	let disposed = false;
	let installed = true;
	let isolateGeneration = 0;
	let activeVersion = manifest.version;
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
				isolateKey: `${entrypoint}-${isolateGeneration++}`,
			}),
		now: () => new Date(currentTime),
		siteInfo,
	} satisfies Parameters<typeof EmDashRuntime.create>[0];

	let runtime = await EmDashRuntime.create(deps);
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
	const updatePluginState = async (status: "active" | "inactive", version = activeVersion) => {
		const now = currentTime.toISOString();
		await bound.DB.prepare(
			`INSERT INTO _plugin_state (plugin_id, status, version, installed_at, activated_at, deactivated_at, data, source, marketplace_version, display_name, description, registry_publisher_did, registry_slug, mcp_tools_enabled, mcp_tools_consent)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, 'config', NULL, NULL, NULL, NULL, NULL, 0, NULL)
			 ON CONFLICT(plugin_id) DO UPDATE SET status = excluded.status, version = excluded.version, activated_at = excluded.activated_at, deactivated_at = excluded.deactivated_at`,
		)
			.bind(
				manifest.id,
				status,
				version,
				now,
				status === "active" ? now : null,
				status === "inactive" ? now : null,
			)
			.run();
	};

	const host: PluginRuntimeTestHost = {
		get manifest() {
			return activeVersion === manifest.version
				? manifest
				: { ...manifest, version: activeVersion };
		},
		transport: {
			invokeHook: (name, event) => {
				assertActive();
				const plugin = runtime.sandboxedPlugins.get(`${manifest.id}:${activeVersion}`);
				if (!plugin) throw new Error(`Plugin isolate is not loaded: ${manifest.id}`);
				return plugin.invokeHook(name, event);
			},
			invokeRoute: (name, input = {}, request = {}) => {
				assertActive();
				const plugin = runtime.sandboxedPlugins.get(`${manifest.id}:${activeVersion}`);
				if (!plugin) throw new Error(`Plugin isolate is not loaded: ${manifest.id}`);
				return plugin.invokeRoute(name, input, {
					url: request.url ?? `https://plugin.test/_emdash/api/plugins/${manifest.id}/${name}`,
					method: request.method ?? "POST",
					headers: request.headers ?? {},
					meta: request.meta ?? { ip: null, userAgent: null, referer: null, geo: null },
					user: request.user,
				});
			},
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
			async collection({ fields = [], ...collection }) {
				assertActive();
				const registry = new SchemaRegistry(runtime.db);
				await registry.createCollection(collection);
				for (const field of fields) await registry.createField(collection.slug, field);
				return { slug: collection.slug };
			},
			async user(input) {
				assertActive();
				const user = await new UserRepository(runtime.db).create(input);
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
				async install() {
					if (!installed) {
						await runtime.shutdown();
						sandboxedPluginEntries.push(entry);
						installed = true;
						await createRuntime();
					}
					await updatePluginState("active");
					await runtime.runPluginInstallLifecycle(manifest.id);
				},
				async activate() {
					if (!installed) throw new Error("Cannot activate an uninstalled plugin");
					await updatePluginState("active");
					await runtime.setPluginStatus(manifest.id, "active");
				},
				async deactivate() {
					if (!installed) throw new Error("Cannot deactivate an uninstalled plugin");
					await updatePluginState("inactive");
					await runtime.setPluginStatus(manifest.id, "inactive");
				},
				async update(version) {
					if (!installed) throw new Error("Cannot update an uninstalled plugin");
					await updatePluginState("active", version);
					await runtime.shutdown();
					activeVersion = version;
					entry.version = version;
					await createRuntime();
					await runtime.runPluginActivateLifecycle(manifest.id);
				},
				async uninstall(deleteData = false) {
					if (!installed) throw new Error("Plugin is already uninstalled");
					await runtime.runPluginUninstallLifecycle(manifest.id, deleteData);
					await runtime.shutdown();
					sandboxedPluginEntries.length = 0;
					installed = false;
					await bound.DB.prepare("DELETE FROM _plugin_state WHERE plugin_id = ?")
						.bind(manifest.id)
						.run();
					if (deleteData) {
						await bound.DB.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ?")
							.bind(manifest.id)
							.run();
					}
					await createRuntime();
				},
			},
			media: { upload: (...args) => runtime.handleMediaUpload(...args) },
			comments: {
				async submit(input) {
					const [collection, content] = await Promise.all([
						runtime.db
							.selectFrom("_emdash_collections")
							.select([
								"comments_enabled",
								"comments_moderation",
								"comments_closed_after_days",
								"comments_auto_approve_users",
							])
							.where("slug", "=", input.collection)
							.executeTakeFirst(),
						new ContentRepository(runtime.db).findById(input.collection, input.contentId),
					]);
					if (!collection?.comments_enabled) throw new Error("Comments are not enabled");
					if (!content || content.status !== "published") {
						throw new Error("Published content not found");
					}
					return runtime.handleCommentCreate(
						input,
						{
							commentsEnabled: true,
							commentsModeration: parseCommentModeration(collection.comments_moderation),
							commentsClosedAfterDays: collection.comments_closed_after_days,
							commentsAutoApproveUsers: collection.comments_auto_approve_users === 1,
						},
						{
							id: content.id,
							collection: input.collection,
							slug: content.slug ?? content.id,
							title: typeof content.data.title === "string" ? content.data.title : undefined,
						},
					);
				},
				moderate: (id, status, moderator) =>
					runtime.handleCommentModerate(id, status, {
						id: moderator.id,
						name: moderator.name,
					}),
			},
			routes: {
				request(name, request = {}) {
					assertActive();
					const headers = new Headers(request.headers);
					let body: BodyInit | undefined;
					if (request.body !== undefined) {
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
					const result = await new ContentRepository(runtime.db).findMany(collection, {
						limit: 100,
					});
					return result.items;
				},
			},
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
			media: (id) => runtime.handleMediaGet(id),
			async comments() {
				const rows = await bound.DB.prepare(
					"SELECT id, collection, content_id AS contentId, body, status FROM _emdash_comments ORDER BY created_at ASC",
				).all();
				return rows.results ?? [];
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
				if (!runtime.cronExecutor) throw new Error("Scheduled task executor is unavailable");
				const processed = await runtime.cronExecutor.tick();
				const { published } = await runtime.runScheduledTasks();
				return { processed, published };
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
