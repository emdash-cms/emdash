/**
 * Plugin State Repository
 *
 * Database-backed storage for plugin activation state.
 * Used by the admin API to persist plugin enable/disable across restarts.
 */

import { sql, type Compilable, type Kysely, type RawBuilder } from "kysely";

import { executeAtomicBatchIfSupported, isSqlite } from "../database/dialect-helpers.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";

export const PLUGIN_STATE_GENERATION_OPTION = "emdash:plugins:generation";
export type PluginStateGeneration = bigint;

export interface PluginStateSnapshot {
	generation: bigint;
	states: PluginState[];
}

const GENERATION_RECEIPTS_KEY = Symbol.for("emdash.plugin-state-generation-receipts");

function generationUpsert(
	db: Kysely<Database>,
	conditional: boolean,
): RawBuilder<{ value: string }> {
	const sqlite = isSqlite(db);
	const where = conditional && sqlite ? sql`WHERE changes() > 0` : sql`WHERE true`;
	// SQLite casts malformed text to zero. Reject it inside the atomic write instead of resetting the clock.
	const previous = sqlite
		? sql`CASE WHEN json_type(options.value) = 'integer'
			AND CAST(CAST(options.value AS BIGINT) AS TEXT) = options.value
			AND CAST(options.value AS BIGINT) >= 0
			AND CAST(options.value AS BIGINT) < 9223372036854775807
			THEN CAST(options.value AS BIGINT) ELSE json_extract('', '$') END`
		: sql`CAST(options.value AS BIGINT)`;
	return sql<{ value: string }>`
		INSERT INTO options (name, value, revision)
		SELECT ${PLUGIN_STATE_GENERATION_OPTION}, '1', ${crypto.randomUUID()}
		${where}
		ON CONFLICT(name) DO UPDATE SET
			value = CAST(${previous} + 1 AS TEXT),
			revision = excluded.revision
		RETURNING value
	`;
}
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis symbol slot is initialized only as this WeakMap
const receipts = ((globalThis as Record<symbol, unknown>)[GENERATION_RECEIPTS_KEY] ??= new WeakMap<
	object,
	bigint
>()) as WeakMap<object, bigint>;

const GENERATION_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const UNSUPPORTED_TRANSACTION_PATTERN = /^transactions are not supported$/i;

function parseGeneration(value: string | null | undefined): bigint {
	if (value == null) return 0n;
	if (!GENERATION_PATTERN.test(value)) {
		throw new Error(`Invalid plugin state generation: ${value}`);
	}
	return BigInt(value);
}

export type PluginStatus = "active" | "inactive";
export type PluginSource = "config" | "marketplace" | "registry";

const TIMEZONE_SUFFIX = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i;
const HOUR_OFFSET_SUFFIX = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}$/i;

function parseDatabaseTimestamp(value: string): Date {
	let normalized = value.trim().replace(" ", "T");
	if (HOUR_OFFSET_SUFFIX.test(normalized)) normalized += ":00";
	else if (!TIMEZONE_SUFFIX.test(normalized)) normalized += "Z";
	return new Date(normalized);
}

function toPluginStatus(value: string): PluginStatus {
	if (value === "active") return "active";
	return "inactive";
}

function toPluginSource(value: string | undefined | null): PluginSource {
	if (value === "marketplace") return "marketplace";
	if (value === "registry") return "registry";
	return "config";
}

export interface PluginState {
	pluginId: string;
	status: PluginStatus;
	version: string;
	installedAt: Date;
	activatedAt: Date | null;
	deactivatedAt: Date | null;
	source: PluginSource;
	marketplaceVersion: string | null;
	displayName: string | null;
	description: string | null;
	/**
	 * Publisher DID this plugin was published under. Populated only when
	 * `source === "registry"`; null otherwise.
	 */
	registryPublisherDid: string | null;
	/**
	 * Slug under which the plugin was published in the publisher's repo
	 * (the rkey of the `pm.fair.package.profile` record). Populated only
	 * when `source === "registry"`; null otherwise.
	 *
	 * The opaque `pluginId` for registry installs is derived from
	 * `(registryPublisherDid, registrySlug)` -- see
	 * `packages/core/src/registry/plugin-id.ts`.
	 */
	registrySlug: string | null;
	mcpToolsEnabled: boolean;
	mcpToolsConsent: string | null;
}

/**
 * Repository for plugin state in the database
 */
export class PluginStateRepository {
	constructor(private db: Kysely<Database>) {}

	/**
	 * Highest generation returned by writes through this handle, possibly by another local caller.
	 * Consume it after any surrounding transaction commits.
	 */
	getLastWrittenGeneration(): bigint | undefined {
		return receipts.get(this.db);
	}

	async getGeneration(): Promise<bigint> {
		const row = await this.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", PLUGIN_STATE_GENERATION_OPTION)
			.executeTakeFirst();
		return parseGeneration(row?.value);
	}

	async getSnapshot(): Promise<PluginStateSnapshot> {
		const rows = await sql<
			Omit<PluginStateRow, "plugin_id"> & { generation: string; plugin_id: string | null }
		>`
			SELECT COALESCE((SELECT value FROM options WHERE name = ${PLUGIN_STATE_GENERATION_OPTION}), '0') AS generation,
			       ps.*
			FROM (SELECT 1 AS anchor) AS a
			LEFT JOIN _plugin_state AS ps ON TRUE
		`.execute(this.db);
		const generation = parseGeneration(rows.rows[0]?.generation);
		return {
			generation,
			states: rows.rows
				// The anchor row has no plugin state; narrow before crossing the row type boundary.
				.filter(
					(row): row is PluginStateRow & { generation: string; plugin_id: string } =>
						row.plugin_id !== null,
				)
				.map((row) => rowToPluginState(row)),
		};
	}

	private async mutate(
		buildStateQuery: (
			db: Kysely<Database>,
		) => Compilable & { executeTakeFirst(): Promise<unknown> },
	): Promise<boolean> {
		const stateQuery = buildStateQuery(this.db);
		const bump = generationUpsert(this.db, false);
		const batched = await executeAtomicBatchIfSupported(this.db, [
			stateQuery,
			generationUpsert(this.db, true),
		]);
		if (batched) {
			const changed = (batched[0]?.rows.length ?? 0) > 0;
			if (changed) {
				const row = batched[1]?.rows[0];
				if (!row || typeof row !== "object" || !("value" in row) || typeof row.value !== "string") {
					throw new Error("Plugin mutation did not publish a generation");
				}
				this.recordGeneration(parseGeneration(row.value));
			}
			return changed;
		}

		let changed = false;
		let writtenGeneration: bigint | undefined;
		const run = async (database: Kysely<Database>) => {
			const result = await buildStateQuery(database).executeTakeFirst();
			changed =
				result !== undefined &&
				typeof result === "object" &&
				result !== null &&
				"plugin_id" in result;
			if (changed) {
				const generation = await bump.execute(database);
				const value = generation.rows[0]?.value;
				if (typeof value !== "string")
					throw new Error("Plugin mutation did not publish a generation");
				writtenGeneration = parseGeneration(value);
			}
		};
		try {
			await withTransaction(this.db, run);
		} catch (error) {
			if (!(error instanceof Error) || !UNSUPPORTED_TRANSACTION_PATTERN.test(error.message))
				throw error;
			await run(this.db);
		}
		if (writtenGeneration !== undefined) this.recordGeneration(writtenGeneration);
		return changed;
	}

	private recordGeneration(generation: bigint): void {
		const previous = receipts.get(this.db);
		if (previous === undefined || generation > previous) receipts.set(this.db, generation);
	}

	/**
	 * Get state for a specific plugin
	 */
	async get(pluginId: string): Promise<PluginState | null> {
		const row = await this.db
			.selectFrom("_plugin_state")
			.selectAll()
			.where("plugin_id", "=", pluginId)
			.executeTakeFirst();

		if (!row) return null;

		return rowToPluginState(row);
	}

	/**
	 * Get all plugin states
	 */
	async getAll(): Promise<PluginState[]> {
		const rows = await this.db.selectFrom("_plugin_state").selectAll().execute();
		return rows.map(rowToPluginState);
	}

	/**
	 * Get all marketplace-installed plugin states
	 */
	async getMarketplacePlugins(): Promise<PluginState[]> {
		const rows = await this.db
			.selectFrom("_plugin_state")
			.selectAll()
			.where("source", "=", "marketplace")
			.execute();
		return rows.map(rowToPluginState);
	}

	/**
	 * Get all registry-installed plugin states.
	 *
	 * The runtime's registry sync path uses this to discover which
	 * registry plugins should be loaded into the sandbox on this worker.
	 */
	async getRegistryPlugins(): Promise<PluginState[]> {
		const rows = await this.db
			.selectFrom("_plugin_state")
			.selectAll()
			.where("source", "=", "registry")
			.execute();
		return rows.map(rowToPluginState);
	}

	/**
	 * Create or update plugin state
	 */
	async upsert(
		pluginId: string,
		version: string,
		status: PluginStatus,
		opts?: {
			source?: PluginSource;
			marketplaceVersion?: string;
			displayName?: string;
			description?: string;
			registryPublisherDid?: string;
			registrySlug?: string;
			mcpToolsEnabled?: boolean;
			mcpToolsConsent?: string | null;
		},
	): Promise<PluginState> {
		const now = new Date().toISOString();
		const existing = await this.get(pluginId);

		if (existing) {
			// Update existing state
			const updates: Record<string, string | number | null> = {
				status,
				version,
			};

			if (status === "active" && existing.status !== "active") {
				updates.activated_at = now;
			} else if (status === "inactive" && existing.status !== "inactive") {
				updates.deactivated_at = now;
			}

			if (opts?.source) updates.source = opts.source;
			if (opts?.marketplaceVersion !== undefined) {
				updates.marketplace_version = opts.marketplaceVersion;
			}
			if (opts?.displayName !== undefined) {
				updates.display_name = opts.displayName;
			}
			if (opts?.description !== undefined) {
				updates.description = opts.description;
			}
			if (opts?.registryPublisherDid !== undefined) {
				updates.registry_publisher_did = opts.registryPublisherDid;
			}
			if (opts?.registrySlug !== undefined) {
				updates.registry_slug = opts.registrySlug;
			}
			if (opts?.mcpToolsEnabled !== undefined) {
				updates.mcp_tools_enabled = opts.mcpToolsEnabled ? 1 : 0;
			}
			if (opts?.mcpToolsConsent !== undefined) {
				updates.mcp_tools_consent = opts.mcpToolsConsent;
			}

			await this.mutate((db) =>
				db
					.updateTable("_plugin_state")
					.set(updates)
					.where("plugin_id", "=", pluginId)
					.returning("plugin_id"),
			);
		} else {
			// Create new state
			await this.mutate((db) =>
				db
					.insertInto("_plugin_state")
					.values({
						plugin_id: pluginId,
						status,
						version,
						installed_at: now,
						activated_at: status === "active" ? now : null,
						deactivated_at: null,
						data: null,
						source: opts?.source ?? "config",
						marketplace_version: opts?.marketplaceVersion ?? null,
						display_name: opts?.displayName ?? null,
						description: opts?.description ?? null,
						registry_publisher_did: opts?.registryPublisherDid ?? null,
						registry_slug: opts?.registrySlug ?? null,
						mcp_tools_enabled: opts?.mcpToolsEnabled ? 1 : 0,
						mcp_tools_consent: opts?.mcpToolsConsent ?? null,
					})
					.returning("plugin_id"),
			);
		}

		return (await this.get(pluginId))!;
	}

	/**
	 * Insert an active state row unless the plugin already has one.
	 *
	 * Returns true only for the caller whose insert created the row, so
	 * concurrent callers agree on a single owner for one-time setup.
	 */
	async createActiveIfAbsent(
		pluginId: string,
		version: string,
		source: PluginSource,
	): Promise<boolean> {
		const now = new Date().toISOString();
		return this.mutate((db) =>
			db
				.insertInto("_plugin_state")
				.values({
					plugin_id: pluginId,
					status: "active",
					version,
					installed_at: now,
					activated_at: now,
					deactivated_at: null,
					data: null,
					source,
					marketplace_version: null,
					display_name: null,
					description: null,
					registry_publisher_did: null,
					registry_slug: null,
					mcp_tools_enabled: 0,
					mcp_tools_consent: null,
				})
				.onConflict((oc) => oc.column("plugin_id").doNothing())
				.returning("plugin_id"),
		);
	}

	async restoreIfVersion(expectedVersion: string, state: PluginState): Promise<boolean> {
		return this.mutate((db) =>
			db
				.updateTable("_plugin_state")
				.set({
					version: state.version,
					status: state.status,
					installed_at: state.installedAt.toISOString(),
					activated_at: state.activatedAt?.toISOString() ?? null,
					deactivated_at: state.deactivatedAt?.toISOString() ?? null,
					source: state.source,
					marketplace_version: state.marketplaceVersion,
					display_name: state.displayName,
					description: state.description,
					registry_publisher_did: state.registryPublisherDid,
					registry_slug: state.registrySlug,
					mcp_tools_enabled: state.mcpToolsEnabled ? 1 : 0,
					mcp_tools_consent: state.mcpToolsConsent,
				})
				.where("plugin_id", "=", state.pluginId)
				.where("version", "=", expectedVersion)
				.where("source", "=", state.source)
				.returning("plugin_id"),
		);
	}

	/**
	 * Enable a plugin
	 */
	async enable(pluginId: string, version: string): Promise<PluginState> {
		return this.upsert(pluginId, version, "active");
	}

	/**
	 * Disable a plugin
	 */
	async disable(pluginId: string, version: string): Promise<PluginState> {
		return this.upsert(pluginId, version, "inactive");
	}

	/**
	 * Delete plugin state
	 */
	async delete(
		pluginId: string,
		conditions?: { version?: string; source?: PluginSource; status?: PluginStatus },
	): Promise<boolean> {
		return this.mutate((db) => {
			let query = db.deleteFrom("_plugin_state").where("plugin_id", "=", pluginId);
			if (conditions?.version !== undefined)
				query = query.where("version", "=", conditions.version);
			if (conditions?.source !== undefined) query = query.where("source", "=", conditions.source);
			if (conditions?.status !== undefined) query = query.where("status", "=", conditions.status);
			return query.returning("plugin_id");
		});
	}
}

/**
 * Map a `_plugin_state` row to the public `PluginState` shape. Every read
 * path uses this, so adding a column to the table means changing this
 * function and nothing else.
 */
export interface PluginStateRow {
	plugin_id: string;
	status: string;
	version: string;
	installed_at: string;
	activated_at: string | null;
	deactivated_at: string | null;
	source: string;
	marketplace_version: string | null;
	display_name: string | null;
	description: string | null;
	registry_publisher_did: string | null;
	registry_slug: string | null;
	mcp_tools_enabled: number;
	mcp_tools_consent: string | null;
}

export function rowToPluginState(row: PluginStateRow): PluginState {
	return {
		pluginId: row.plugin_id,
		status: toPluginStatus(row.status),
		version: row.version,
		installedAt: parseDatabaseTimestamp(row.installed_at),
		activatedAt: row.activated_at ? parseDatabaseTimestamp(row.activated_at) : null,
		deactivatedAt: row.deactivated_at ? parseDatabaseTimestamp(row.deactivated_at) : null,
		source: toPluginSource(row.source),
		marketplaceVersion: row.marketplace_version ?? null,
		displayName: row.display_name ?? null,
		description: row.description ?? null,
		registryPublisherDid: row.registry_publisher_did ?? null,
		registrySlug: row.registry_slug ?? null,
		mcpToolsEnabled: row.mcp_tools_enabled === 1,
		mcpToolsConsent: row.mcp_tools_consent ?? null,
	};
}
