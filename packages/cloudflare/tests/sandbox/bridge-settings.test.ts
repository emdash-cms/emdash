import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge } from "../../src/sandbox/bridge.js";

function optionsD1() {
	const values = new Map<string, { value: string; revision: string }>();
	return {
		values,
		database: {
			prepare(sql: string) {
				const statement = {
					params: [] as unknown[],
					bind(...params: unknown[]) {
						statement.params = params;
						return statement;
					},
					async first() {
						if (!sql.includes('from "options"')) return null;
						const row = values.get(String(statement.params[0]));
						return row ?? null;
					},
					async all() {
						if (sql.startsWith('insert into "options"')) {
							values.set(String(statement.params[0]), {
								value: String(statement.params[1]),
								revision: String(statement.params[2]),
							});
							return { results: [], meta: { changes: 1 } };
						}
						if (sql.includes('from "options"')) {
							const row = values.get(String(statement.params[0]));
							return { results: row ? [row] : [], meta: { changes: 0 } };
						}
						return { results: [], meta: { changes: 0 } };
					},
					async run() {
						if (sql.startsWith('insert into "options"')) {
							values.set(String(statement.params[0]), {
								value: String(statement.params[1]),
								revision: String(statement.params[2]),
							});
							return { meta: { changes: 1 } };
						}
						return { meta: { changes: 0 } };
					},
				};
				return statement;
			},
		},
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("PluginBridge settings", () => {
	it("encrypts with the Worker secret binding when process.env is empty", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "");
		const d1 = optionsD1();
		const bridge = new PluginBridge(
			{
				props: {
					pluginId: "binding-plugin",
					pluginVersion: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storageCollections: [],
					settingsSchema: { apiKey: { type: "secret", label: "API key" } },
				},
			} as never,
			{
				DB: d1.database,
				EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			} as never,
		);

		await bridge.settingsSet("apiKey", "worker-binding-secret");
		await expect(bridge.settingsGet("apiKey")).resolves.toBe("worker-binding-secret");
		const stored = d1.values.get("plugin:binding-plugin:settings:apiKey");
		expect(stored?.value).not.toContain("worker-binding-secret");
		expect(JSON.parse(stored!.value)).toMatchObject({ v: 1, kid: expect.any(String) });

		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		bridge.log("error", "credential=worker-binding-secret", {
			token: "worker-binding-secret",
		});
		expect(JSON.stringify(errorLog.mock.calls)).toContain("[REDACTED]");
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain("worker-binding-secret");
	});
});
