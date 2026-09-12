import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { pluginManifestSchema } from "@emdash-cms/plugin-types";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	ContentRepository,
	SchemaRegistry,
	type CreateCollectionInput,
	type CreateFieldInput,
	type Database,
	type PluginManifest,
} from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely } from "kysely";

interface PluginTestBindings {
	DB: D1Database;
	EMDASH_PLUGIN_CODE: string;
	EMDASH_PLUGIN_MANIFEST: string;
}

export interface PluginTestRequest {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	meta?: {
		ip: string | null;
		userAgent: string | null;
		referer: string | null;
		geo: { country: string | null; region: string | null; city: string | null } | null;
	};
	user?: {
		id: string;
		email: string;
		name: string | null;
		role: number;
		createdAt: string;
	};
}

export interface PluginTestCollection extends CreateCollectionInput {
	fields?: CreateFieldInput[];
}

export interface PluginStorageTestEntry<T = unknown> {
	id: string;
	data: T;
}

export interface PluginTestHost {
	readonly manifest: PluginManifest;
	invokeHook(name: string, event: unknown): Promise<unknown>;
	invokeRoute(name: string, input?: unknown, request?: PluginTestRequest): Promise<unknown>;
	createCollection(input: PluginTestCollection): Promise<void>;
	seedContent(collection: string, items: Array<Record<string, unknown>>): Promise<void>;
	storage<T = unknown>(
		collection: string,
	): {
		get(id: string): Promise<T | null>;
		list(): Promise<Array<PluginStorageTestEntry<T>>>;
	};
	kv: {
		get<T = unknown>(key: string): Promise<T | null>;
		list(): Promise<Array<PluginStorageTestEntry>>;
	};
	dispose(): Promise<void>;
}

const DEFAULT_META = {
	ip: null,
	userAgent: null,
	referer: null,
	geo: null,
} as const;

function isPluginTestBindings(value: unknown): value is PluginTestBindings {
	if (typeof value !== "object" || value === null) return false;
	if (!("DB" in value) || typeof value.DB !== "object" || value.DB === null) return false;
	return (
		"prepare" in value.DB &&
		typeof value.DB.prepare === "function" &&
		"EMDASH_PLUGIN_CODE" in value &&
		typeof value.EMDASH_PLUGIN_CODE === "string" &&
		"EMDASH_PLUGIN_MANIFEST" in value &&
		typeof value.EMDASH_PLUGIN_MANIFEST === "string"
	);
}

/**
 * Load the configured plugin through EmDash's production Cloudflare sandbox runner.
 */
export async function createPluginTestHost(): Promise<PluginTestHost> {
	const bindings: unknown = env;
	if (!isPluginTestBindings(bindings)) {
		throw new Error(
			"EmDash plugin test bindings are unavailable; add emdashPluginTest() to Vitest",
		);
	}
	const manifestResult = pluginManifestSchema.safeParse(
		JSON.parse(bindings.EMDASH_PLUGIN_MANIFEST),
	);
	if (!manifestResult.success) throw new Error("EmDash plugin test manifest is invalid");
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the shared runtime schema validates the wire manifest before it enters core's equivalent runtime type
	const manifest = manifestResult.data as unknown as PluginManifest;
	const db = new Kysely<Database>({
		dialect: createDialect({ binding: "DB", session: "disabled" }),
	});
	await runMigrations(db);

	const runner = new CloudflareSandboxRunner({
		db,
		siteInfo: {
			name: "EmDash plugin test site",
			url: "https://plugin.test",
			locale: "en",
		},
	});
	if (!runner.isAvailable()) {
		await db.destroy();
		throw new Error(`Plugin sandbox unavailable: ${runner.unavailableReason()}`);
	}
	const plugin = await runner.load(manifest, bindings.EMDASH_PLUGIN_CODE);
	const registry = new SchemaRegistry(db);
	const content = new ContentRepository(db);
	let disposed = false;

	const assertActive = () => {
		if (disposed) throw new Error("Plugin test host has been disposed");
	};
	const readStorage = async <T>(collection: string, id?: string) => {
		assertActive();
		let query = bindings.DB.prepare(
			"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = ?",
		).bind(manifest.id, collection);
		if (id !== undefined) {
			query = bindings.DB.prepare(
				"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
			).bind(manifest.id, collection, id);
		}
		const result = await query.all<{ id: string; data: string }>();
		return (result.results ?? []).map((row) => ({
			id: row.id,
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the caller supplies the expected stored JSON type
			data: JSON.parse(row.data) as T,
		}));
	};

	return {
		manifest,
		async invokeHook(name, event) {
			assertActive();
			return plugin.invokeHook(name, event);
		},
		async invokeRoute(name, input = {}, request = {}) {
			assertActive();
			return plugin.invokeRoute(name, input, {
				url: request.url ?? `https://plugin.test/_emdash/api/plugins/${manifest.id}/${name}`,
				method: request.method ?? "POST",
				headers: request.headers ?? {},
				meta: request.meta ?? DEFAULT_META,
				user: request.user,
			});
		},
		async createCollection({ fields = [], ...collection }) {
			assertActive();
			await registry.createCollection(collection);
			for (const field of fields) await registry.createField(collection.slug, field);
		},
		async seedContent(collection, items) {
			assertActive();
			for (const data of items) await content.create({ type: collection, data });
		},
		storage<T>(collection: string) {
			return {
				async get(id: string) {
					const rows = await readStorage<T>(collection, id);
					return rows[0]?.data ?? null;
				},
				list: () => readStorage<T>(collection),
			};
		},
		kv: {
			async get<T>(key: string) {
				const rows = await readStorage<T>("__kv", key);
				return rows[0]?.data ?? null;
			},
			list: () => readStorage("__kv"),
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await runner.terminateAll();
			await db.destroy();
			await reset();
		},
	};
}
