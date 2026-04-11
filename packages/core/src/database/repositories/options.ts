import { sql, type Kysely, type SqlBool } from "kysely";

import type { Database, OptionTable } from "../types.js";

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Options repository for key-value settings storage
 *
 * Used for site settings, plugin configuration, and other arbitrary key-value data.
 * Values are stored as JSON for flexibility.
 */
export class OptionsRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Get an option value
	 */
	async get<T = unknown>(name: string): Promise<T | null> {
		const row = await this.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", name)
			.executeTakeFirst();

		if (!row) return null;
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- JSON.parse returns any; generic callers provide T
		return JSON.parse(row.value) as T;
	}

	/**
	 * Get an option value with a default
	 */
	async getOrDefault<T>(name: string, defaultValue: T): Promise<T> {
		const value = await this.get<T>(name);
		return value ?? defaultValue;
	}

	/**
	 * Set an option value (creates or updates)
	 */
	async set<T = unknown>(name: string, value: T): Promise<void> {
		const row: OptionTable = {
			name,
			value: JSON.stringify(value),
		};

		// Upsert: insert or replace
		await this.db
			.insertInto("options")
			.values(row)
			.onConflict((oc) => oc.column("name").doUpdateSet({ value: row.value }))
			.execute();
	}

	/**
	 * Delete an option
	 */
	async delete(name: string): Promise<boolean> {
		const result = await this.db.deleteFrom("options").where("name", "=", name).executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Check if an option exists
	 */
	async exists(name: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("options")
			.select("name")
			.where("name", "=", name)
			.executeTakeFirst();

		return !!row;
	}

	/**
	 * Get multiple options at once
	 */
	async getMany<T = unknown>(names: string[]): Promise<Map<string, T>> {
		if (names.length === 0) return new Map();

		const rows = await this.db
			.selectFrom("options")
			.select(["name", "value"])
			.where("name", "in", names)
			.execute();

		const result = new Map<string, T>();
		for (const row of rows) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- JSON.parse returns any; generic callers provide T
			result.set(row.name, JSON.parse(row.value) as T);
		}
		return result;
	}

	/**
	 * Set multiple options at once
	 */
	async setMany<T = unknown>(options: Record<string, T>): Promise<void> {
		const entries = Object.entries(options);
		if (entries.length === 0) return;

		for (const [name, value] of entries) {
			await this.set(name, value);
		}
	}

	/**
	 * Get all options (use sparingly)
	 */
	async getAll(): Promise<Map<string, unknown>> {
		const rows = await this.db.selectFrom("options").select(["name", "value"]).execute();

		const result = new Map<string, unknown>();
		for (const row of rows) {
			result.set(row.name, JSON.parse(row.value));
		}
		return result;
	}

	/**
	 * Get all options matching a prefix
	 */
	async getByPrefix<T = unknown>(prefix: string): Promise<Map<string, T>> {
		const pattern = `${escapeLike(prefix)}%`;
		const rows = await this.db
			.selectFrom("options")
			.select(["name", "value"])
			.where(sql<SqlBool>`name LIKE ${pattern} ESCAPE '\\'`)
			.execute();

		const result = new Map<string, T>();
		for (const row of rows) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- JSON.parse returns any; generic callers provide T
			result.set(row.name, JSON.parse(row.value) as T);
		}
		return result;
	}

	/**
	 * Delete all options matching a prefix
	 */
	async deleteByPrefix(prefix: string): Promise<number> {
		const pattern = `${escapeLike(prefix)}%`;
		const result = await this.db
			.deleteFrom("options")
			.where(sql<SqlBool>`name LIKE ${pattern} ESCAPE '\\'`)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}
}
