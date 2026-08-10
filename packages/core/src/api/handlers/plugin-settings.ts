/**
 * Plugin settings handlers
 *
 * Auto-generated settings UI backend for plugins that declare
 * `admin.settingsSchema`. Values are stored in the options table under
 * `plugin:{pluginId}:settings:{key}` — the same keys the plugin itself
 * reads via `ctx.kv.get("settings:{key}")`.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../../database/repositories/options.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import type { SandboxedPluginEntry } from "../../emdash-runtime.js";
import type { ResolvedPlugin, SettingField } from "../../plugins/types.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";

export interface PluginSettingsResponse {
	/** The plugin's declared settings schema, keyed by setting name */
	schema: Record<string, SettingField>;
	/**
	 * Current values keyed by setting name. Secret fields are never
	 * included here — check `secretsSet` instead.
	 */
	values: Record<string, unknown>;
	/** For secret fields: whether a value is currently stored */
	secretsSet: Record<string, boolean>;
}

function settingsKey(pluginId: string, key: string): string {
	return `plugin:${pluginId}:settings:${key}`;
}

/**
 * Resolve a plugin's settings schema from either the configured
 * (in-process) plugin list or the statically-sandboxed entries.
 * Returns null when the plugin doesn't exist, undefined-equivalent
 * empty object when it declares no schema.
 */
export function getPluginSettingsSchema(
	configuredPlugins: ResolvedPlugin[],
	sandboxedPluginEntries: SandboxedPluginEntry[],
	pluginId: string,
): Record<string, SettingField> | null {
	const plugin = configuredPlugins.find((p) => p.id === pluginId);
	if (plugin) return plugin.admin.settingsSchema ?? {};

	const sandboxed = sandboxedPluginEntries.find((e) => e.id === pluginId);
	if (sandboxed) return sandboxed.settingsSchema ?? {};

	return null;
}

/**
 * Validate a single value against its schema field.
 * Returns an error message, or null when valid.
 */
function validateValue(key: string, field: SettingField, value: unknown): string | null {
	switch (field.type) {
		case "string":
		case "secret":
		case "url":
		case "email":
			if (typeof value !== "string") return `Setting "${key}" must be a string`;
			if (field.type === "url" && value !== "" && !URL.canParse(value)) {
				return `Setting "${key}" must be a valid URL`;
			}
			if (field.type === "email" && value !== "" && !value.includes("@")) {
				return `Setting "${key}" must be a valid email address`;
			}
			return null;
		case "number": {
			if (typeof value !== "number" || Number.isNaN(value)) {
				return `Setting "${key}" must be a number`;
			}
			if (field.min !== undefined && value < field.min) {
				return `Setting "${key}" must be at least ${field.min}`;
			}
			if (field.max !== undefined && value > field.max) {
				return `Setting "${key}" must be at most ${field.max}`;
			}
			return null;
		}
		case "boolean":
			return typeof value === "boolean" ? null : `Setting "${key}" must be a boolean`;
		case "select":
			if (typeof value !== "string" || !field.options.some((o) => o.value === value)) {
				return `Setting "${key}" must be one of the defined options`;
			}
			return null;
		default: {
			const _exhaustive: never = field;
			return `Setting "${key}" has an unknown field type`;
		}
	}
}

async function buildSettingsResponse(
	optionsRepo: OptionsRepository,
	pluginId: string,
	schema: Record<string, SettingField>,
): Promise<PluginSettingsResponse> {
	const keys = Object.keys(schema);
	const stored = await optionsRepo.getMany(keys.map((key) => settingsKey(pluginId, key)));

	const values: Record<string, unknown> = {};
	const secretsSet: Record<string, boolean> = {};

	for (const key of keys) {
		const field = schema[key];
		if (!field) continue;
		const storedValue = stored.get(settingsKey(pluginId, key));

		if (field.type === "secret") {
			secretsSet[key] = typeof storedValue === "string" && storedValue.length > 0;
			continue;
		}

		if (storedValue !== undefined && storedValue !== null) {
			values[key] = storedValue;
		} else if ("default" in field && field.default !== undefined) {
			values[key] = field.default;
		} else {
			values[key] = null;
		}
	}

	return { schema, values, secretsSet };
}

/**
 * Get a plugin's settings (schema + current values, secrets masked)
 */
export async function handlePluginSettingsGet(
	db: Kysely<Database>,
	pluginId: string,
	schema: Record<string, SettingField>,
): Promise<ApiResult<PluginSettingsResponse>> {
	try {
		const optionsRepo = new OptionsRepository(db);
		return { success: true, data: await buildSettingsResponse(optionsRepo, pluginId, schema) };
	} catch {
		return {
			success: false,
			error: {
				code: ErrorCode.PLUGIN_SETTINGS_READ_ERROR,
				message: "Failed to read plugin settings",
			},
		};
	}
}

/**
 * Update a plugin's settings.
 *
 * Only keys present in `updates` are written. A `null` value deletes the
 * stored value (reverting to the schema default). Secret fields are
 * write-only: they accept a new string value or `null` to clear, and the
 * response never echoes them back.
 */
export async function handlePluginSettingsUpdate(
	db: Kysely<Database>,
	pluginId: string,
	schema: Record<string, SettingField>,
	updates: Record<string, unknown>,
): Promise<ApiResult<PluginSettingsResponse>> {
	try {
		// Validate everything before writing anything.
		for (const [key, value] of Object.entries(updates)) {
			const field = schema[key];
			if (!field) {
				return {
					success: false,
					error: {
						code: ErrorCode.VALIDATION_ERROR,
						message: `Unknown setting "${key}" for plugin "${pluginId}"`,
					},
				};
			}
			if (value === null) continue;
			const error = validateValue(key, field, value);
			if (error) {
				return {
					success: false,
					error: { code: ErrorCode.VALIDATION_ERROR, message: error },
				};
			}
		}

		// Wrap the writes + read-back in a transaction so a partial failure
		// can't leave some settings updated and others not. On D1
		// withTransaction degrades to running the callback directly — D1 is
		// single-writer, so per-statement atomicity still holds.
		const data = await withTransaction(db, async (trx) => {
			const txRepo = new OptionsRepository(trx);
			for (const [key, value] of Object.entries(updates)) {
				if (value === null) {
					await txRepo.delete(settingsKey(pluginId, key));
				} else {
					await txRepo.set(settingsKey(pluginId, key), value);
				}
			}
			return buildSettingsResponse(txRepo, pluginId, schema);
		});

		return { success: true, data };
	} catch {
		return {
			success: false,
			error: {
				code: ErrorCode.PLUGIN_SETTINGS_UPDATE_ERROR,
				message: "Failed to update plugin settings",
			},
		};
	}
}
