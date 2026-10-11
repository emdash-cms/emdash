import { type Kysely } from "kysely";

import { getRequestContext } from "../../request-context.js";
import type { Database } from "../types.js";

export function selectedSiteId(): string {
	const siteId = getRequestContext()?.siteId;
	if (!siteId) throw new Error("A server-selected site is required for site settings");
	return siteId;
}

function siteSettingName(siteId: string, key: string): string {
	if (!key || key.includes(":")) throw new Error("Invalid site setting key");
	return `site:${siteId}:${key}`;
}

export class SiteSettingsRepository {
	constructor(private readonly db: Kysely<Database>) {}

	async get<T>(key: string): Promise<T | undefined> {
		const siteId = selectedSiteId();
		const row = await this.db
			.selectFrom("options")
			.select("value")
			.where("site_id", "=", siteId)
			.where("name", "=", siteSettingName(siteId, key))
			.executeTakeFirst();
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- caller supplies the JSON value type
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	async getAll(): Promise<Map<string, unknown>> {
		const siteId = selectedSiteId();
		const prefix = `site:${siteId}:`;
		const rows = await this.db
			.selectFrom("options")
			.select(["name", "value"])
			.where("site_id", "=", siteId)
			.where("name", "like", `${prefix}%`)
			.execute();
		return new Map(
			rows
				.filter((row) => row.name.startsWith(prefix))
				.map((row) => [row.name.slice(prefix.length), JSON.parse(row.value)]),
		);
	}

	async set(key: string, value: unknown): Promise<void> {
		const siteId = selectedSiteId();
		const name = siteSettingName(siteId, key);
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("Invalid site setting value");
		await this.db
			.insertInto("options")
			.values({ site_id: siteId, name, value: serialized, revision: crypto.randomUUID() })
			.onConflict((oc) =>
				oc.column("name").doUpdateSet({ value: serialized, revision: crypto.randomUUID() }),
			)
			.execute();
	}

	async setIfAbsent(key: string, value: unknown): Promise<boolean> {
		const siteId = selectedSiteId();
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("Invalid site setting value");
		const result = await this.db
			.insertInto("options")
			.values({
				site_id: siteId,
				name: siteSettingName(siteId, key),
				value: serialized,
				revision: crypto.randomUUID(),
			})
			.onConflict((oc) => oc.column("name").doNothing())
			.executeTakeFirst();
		return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
	}

	async delete(key: string): Promise<void> {
		const siteId = selectedSiteId();
		await this.db
			.deleteFrom("options")
			.where("site_id", "=", siteId)
			.where("name", "=", siteSettingName(siteId, key))
			.execute();
	}
}
