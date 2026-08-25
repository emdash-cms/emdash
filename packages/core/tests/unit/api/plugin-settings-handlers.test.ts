/**
 * Plugin settings handlers: auto-generated settings UI backend (#341).
 *
 * Values must land under `plugin:{id}:settings:{key}` in the options
 * table — the same keys plugins read via `ctx.kv.get("settings:{key}")` —
 * and secret fields must never be echoed back to the client.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getPluginSettingsSchema,
	handlePluginSettingsGet,
	handlePluginSettingsUpdate,
} from "../../../src/api/handlers/plugin-settings.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxedPluginEntry } from "../../../src/emdash-runtime.js";
import type { ResolvedPlugin, SettingField } from "../../../src/plugins/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const PLUGIN_ID = "test-plugin";

const SCHEMA: Record<string, SettingField> = {
	apiUrl: { type: "url", label: "API URL", placeholder: "https://example.com" },
	retries: { type: "number", label: "Retries", min: 0, max: 10, default: 3 },
	enabled: { type: "boolean", label: "Enabled", default: true },
	mode: {
		type: "select",
		label: "Mode",
		options: [
			{ value: "fast", label: "Fast" },
			{ value: "safe", label: "Safe" },
		],
		default: "safe",
	},
	apiKey: { type: "secret", label: "API Key" },
	note: { type: "string", label: "Note", multiline: true },
};

function makePlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal test fixture
	return {
		id: PLUGIN_ID,
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { settingsSchema: SCHEMA },
		hooks: {},
		routes: {},
		...overrides,
	} as ResolvedPlugin;
}

describe("getPluginSettingsSchema", () => {
	it("resolves the schema from a configured plugin", () => {
		expect(getPluginSettingsSchema([makePlugin()], [], PLUGIN_ID)).toBe(SCHEMA);
	});

	it("resolves the schema from a sandboxed entry", () => {
		const entry: SandboxedPluginEntry = {
			id: "sandboxed",
			version: "1.0.0",
			options: {},
			code: "",
			capabilities: [],
			allowedHosts: [],
			storage: {},
			settingsSchema: SCHEMA,
		};
		expect(getPluginSettingsSchema([], [entry], "sandboxed")).toBe(SCHEMA);
	});

	it("returns an empty schema for a plugin without settingsSchema", () => {
		expect(getPluginSettingsSchema([makePlugin({ admin: {} })], [], PLUGIN_ID)).toEqual({});
	});

	it("returns null for an unknown plugin", () => {
		expect(getPluginSettingsSchema([], [], "nope")).toBeNull();
	});
});

describe("plugin settings handlers", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("GET returns schema defaults when nothing is stored", async () => {
		const result = await handlePluginSettingsGet(db, PLUGIN_ID, SCHEMA);
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.values).toEqual({
			apiUrl: null,
			retries: 3,
			enabled: true,
			mode: "safe",
			note: null,
		});
		expect(result.data.secretsSet).toEqual({ apiKey: false });
		// Secret values never appear in `values`.
		expect("apiKey" in result.data.values).toBe(false);
	});

	it("PUT stores values under the plugin's settings: KV keys", async () => {
		const result = await handlePluginSettingsUpdate(db, PLUGIN_ID, SCHEMA, {
			apiUrl: "https://api.example.com",
			retries: 5,
			enabled: false,
			mode: "fast",
			apiKey: "s3cret",
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		// Response reflects the new values, secrets masked but flagged.
		expect(result.data.values.apiUrl).toBe("https://api.example.com");
		expect(result.data.values.retries).toBe(5);
		expect(result.data.values.enabled).toBe(false);
		expect(result.data.values.mode).toBe("fast");
		expect(result.data.secretsSet).toEqual({ apiKey: true });
		expect("apiKey" in result.data.values).toBe(false);

		// Stored exactly where `ctx.kv.get("settings:{key}")` reads.
		const options = new OptionsRepository(db);
		expect(await options.get(`plugin:${PLUGIN_ID}:settings:apiKey`)).toBe("s3cret");
		expect(await options.get(`plugin:${PLUGIN_ID}:settings:retries`)).toBe(5);
	});

	it("PUT with null clears a stored value (reverting to the default)", async () => {
		await handlePluginSettingsUpdate(db, PLUGIN_ID, SCHEMA, { retries: 7, apiKey: "x" });

		const result = await handlePluginSettingsUpdate(db, PLUGIN_ID, SCHEMA, {
			retries: null,
			apiKey: null,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.values.retries).toBe(3);
		expect(result.data.secretsSet).toEqual({ apiKey: false });

		const options = new OptionsRepository(db);
		expect(await options.get(`plugin:${PLUGIN_ID}:settings:retries`)).toBeNull();
	});

	it("PUT rejects unknown keys and writes nothing", async () => {
		const result = await handlePluginSettingsUpdate(db, PLUGIN_ID, SCHEMA, {
			retries: 5,
			bogus: "nope",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");

		// Validation happens before any write — the valid key wasn't stored either.
		const options = new OptionsRepository(db);
		expect(await options.get(`plugin:${PLUGIN_ID}:settings:retries`)).toBeNull();
	});

	it.each([
		["number out of range", { retries: 99 }],
		["wrong type for number", { retries: "five" }],
		["wrong type for boolean", { enabled: "yes" }],
		["select value not in options", { mode: "turbo" }],
		["invalid url", { apiUrl: "not a url" }],
	])("PUT rejects %s", async (_label, updates) => {
		const result = await handlePluginSettingsUpdate(db, PLUGIN_ID, SCHEMA, updates);
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});
});
