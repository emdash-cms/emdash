import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import type { StorageCollection } from "emdash";
import { PluginStorageRepository } from "emdash";
import { runMigrations } from "emdash/db";
import { createDialect } from "emdash/db/sqlite";

import { FORMS_STORAGE_CONFIG } from "../src/storage.js";

/**
 * Kysely is a dependency of emdash, not of this package. Load the copy emdash resolves so the
 * repository and the database share one Kysely module.
 */
async function loadKysely() {
	const emdashEntry = createRequire(import.meta.url).resolve("emdash");
	const kyselyEntry = createRequire(emdashEntry).resolve("kysely");
	return import(pathToFileURL(kyselyEntry).href);
}

export interface FormsStorage {
	db: { destroy(): Promise<void> };
	storage: { forms: StorageCollection; submissions: StorageCollection };
}

/**
 * The plugin's storage as the runtime builds it: core migrations on an in-memory SQLite database,
 * one `PluginStorageRepository` per declared collection, and the unique `slug` index.
 */
export async function createFormsStorage(): Promise<FormsStorage> {
	const { Kysely, sql } = await loadKysely();
	const db = new Kysely({ dialect: createDialect({ url: ":memory:" }) });
	await runMigrations(db);

	const pluginId = "emdash-forms";
	await sql`CREATE UNIQUE INDEX "uidx_plugin_emdash-forms_forms_slug"
		ON _plugin_storage(plugin_id, collection, json_extract(data, '$.slug'))`.execute(db);

	const storage = {
		forms: new PluginStorageRepository(db, pluginId, "forms", [
			...FORMS_STORAGE_CONFIG.forms.indexes,
			...FORMS_STORAGE_CONFIG.forms.uniqueIndexes,
		]),
		submissions: new PluginStorageRepository(
			db,
			pluginId,
			"submissions",
			FORMS_STORAGE_CONFIG.submissions.indexes.map((index) =>
				typeof index === "string" ? index : [...index],
			),
		),
	};
	return { db, storage };
}

/**
 * Wraps a real collection so the first call to one of `methods` waits until `release()` runs.
 * `reached` resolves when that call arrives, which lets a test run other work in the gap.
 */
export function holdFirstCall<T extends object>(target: T, methods: readonly string[]) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let markReached!: () => void;
	const reached = new Promise<void>((resolve) => (markReached = resolve));
	let armed = true;

	const proxy = new Proxy(target, {
		get(obj, prop) {
			const value: unknown = Reflect.get(obj, prop);
			if (typeof value !== "function") return value;
			const method = value as (...args: unknown[]) => unknown;
			if (armed && methods.includes(String(prop))) {
				return async (...args: unknown[]) => {
					armed = false;
					markReached();
					await released;
					return method.apply(obj, args);
				};
			}
			return method.bind(obj);
		},
	});
	return { proxy, reached, release };
}
