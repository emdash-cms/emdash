import { sql, type Kysely } from "kysely";

type PluginKvMigrationTables = {
	_plugin_storage: {
		plugin_id: string;
		collection: string;
		id: string;
		data: string;
		revision: string;
	};
	options: {
		name: string;
		value: string;
		revision: string;
	};
};

// Each inserted row binds three values; D1 permits 100 parameters per statement.
const BATCH_SIZE = 33;

export async function up(db: Kysely<unknown>): Promise<void> {
	const typedDb = db.withTables<PluginKvMigrationTables>();
	let cursor: { pluginId: string; id: string } | undefined;

	while (true) {
		let query = typedDb
			.selectFrom("_plugin_storage as legacy")
			.leftJoin("options as existing", (join) =>
				join.on(
					"existing.name",
					"=",
					sql<string>`'plugin:' || legacy.plugin_id || ':' || legacy.id`,
				),
			)
			.select([
				"legacy.plugin_id",
				"legacy.id",
				"legacy.data",
				"legacy.revision",
				"existing.value as existingValue",
			])
			.where("legacy.collection", "=", "__kv")
			.where(sql<boolean>`substr(legacy.id, 1, 9) <> 'settings:'`)
			.orderBy("legacy.plugin_id", "asc")
			.orderBy("legacy.id", "asc")
			.limit(BATCH_SIZE);

		const currentCursor = cursor;
		if (currentCursor) {
			query = query.where((eb) =>
				eb.or([
					eb("legacy.plugin_id", ">", currentCursor.pluginId),
					eb.and([
						eb("legacy.plugin_id", "=", currentCursor.pluginId),
						eb("legacy.id", ">", currentCursor.id),
					]),
				]),
			);
		}

		const rows = await query.execute();
		if (rows.length === 0) return;

		for (const row of rows) {
			if (row.existingValue !== null && row.existingValue !== row.data) {
				console.warn(
					"[plugin-kv-migration] Conflicting KV values; keeping the in-process value. Review the retained sandbox value before resuming plugin writes: https://docs.emdashcms.com/plugins/upgrading-sites/#resolve-conflicting-kv-values",
					{ pluginId: row.plugin_id, key: row.id },
				);
			}
		}

		await typedDb
			.insertInto("options")
			.values(
				rows.map((row) => ({
					name: `plugin:${row.plugin_id}:${row.id}`,
					value: row.data,
					revision: row.revision,
				})),
			)
			.onConflict((oc) => oc.column("name").doNothing())
			.execute();

		const last = rows.at(-1);
		if (!last) return;
		cursor = { pluginId: last.plugin_id, id: last.id };
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Forward-only data migration; legacy storage remains available as a backup.
}
