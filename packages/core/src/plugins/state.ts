/**
 * Plugin State Repository
 *
 * Database-backed storage for plugin activation state.
 * Used by the admin API to persist plugin enable/disable across restarts.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

export type PluginStatus = "active" | "inactive";
export type PluginSource = "config" | "marketplace" | "registry";

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
}

/**
 * Repository for plugin state in the database
 */
export class PluginStateRepository {
	constructor(private db: Kysely<Database>) {}

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
		},
	): Promise<PluginState> {
		const now = new Date().toISOString();
		const existing = await this.get(pluginId);

		if (existing) {
			// Update existing state
			const updates: Record<string, string | null> = {
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

			await this.db
				.updateTable("_plugin_state")
				.set(updates)
				.where("plugin_id", "=", pluginId)
				.execute();
		} else {
			// Create new state
			await this.db
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
				})
				.execute();
		}

		return (await this.get(pluginId))!;
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
	async delete(pluginId: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_plugin_state")
			.where("plugin_id", "=", pluginId)
			.executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}
}

/**
 * Internal: map a `_plugin_state` row to the public `PluginState` shape.
 *
 * Kept at module scope so the three select paths (`get`, `getAll`,
 * `getMarketplacePlugins`, `getRegistryPlugins`) stay byte-identical in
 * their handling of nullable columns -- adding a new column to the table
 * means changing this function and nothing else.
 */
interface PluginStateRow {
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
}

function rowToPluginState(row: PluginStateRow): PluginState {
	return {
		pluginId: row.plugin_id,
		status: toPluginStatus(row.status),
		version: row.version,
		installedAt: new Date(row.installed_at),
		activatedAt: row.activated_at ? new Date(row.activated_at) : null,
		deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
		source: toPluginSource(row.source),
		marketplaceVersion: row.marketplace_version ?? null,
		displayName: row.display_name ?? null,
		description: row.description ?? null,
		registryPublisherDid: row.registry_publisher_did ?? null,
		registrySlug: row.registry_slug ?? null,
	};
}
