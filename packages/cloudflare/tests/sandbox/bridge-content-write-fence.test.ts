import { describe, expect, it, vi } from "vitest";

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

const bridgeContext = {
	props: {
		pluginId: "test-plugin",
		pluginVersion: "1.0.0",
		capabilities: ["content:read", "content:write"],
		allowedHosts: [],
		storageCollections: [],
	},
};

function makeBridge(db: unknown, i18nConfig?: { defaultLocale: string; locales: string[] } | null) {
	return new PluginBridge(
		{
			...bridgeContext,
			props: { ...bridgeContext.props, i18nConfig },
		} as never,
		{ DB: db } as never,
	);
}

describe("PluginBridge content write fence", () => {
	it("returns locale from content reads", async () => {
		const db = {
			prepare() {
				return {
					bind() {
						return this;
					},
					async first() {
						return {
							id: "post-id",
							locale: "fr",
							created_at: "2026-08-16T00:00:00.000Z",
							updated_at: "2026-08-16T00:00:00.000Z",
						};
					},
				};
			},
		};

		const item = await makeBridge(db).contentGet("posts", "post-id");

		expect(item?.locale).toBe("fr");
	});

	it("rejects content mutations while media usage activation is incomplete", async () => {
		const queries: string[] = [];
		const db = {
			prepare(sql: string) {
				queries.push(sql);
				return {
					bind() {
						return this;
					},
					async first() {
						return { state: "activating" };
					},
					async run() {
						return { meta: { changes: 1 } };
					},
				};
			},
		};
		const bridge = makeBridge(db);

		await expect(bridge.contentCreate("posts", { slug: "blocked" })).rejects.toMatchObject({
			code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			message: "Media usage activation is in progress",
			status: 503,
		});
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("_emdash_media_usage_activation");
	});

	it("preserves content writes before the activation table is migrated", async () => {
		const queries: string[] = [];
		const db = {
			prepare(sql: string) {
				queries.push(sql);
				const statement = {
					bind() {
						return statement;
					},
					async first() {
						if (sql.includes("_emdash_media_usage_activation")) {
							throw new Error("D1_ERROR: no such table: _emdash_media_usage_activation");
						}
						return {
							id: "created-id",
							created_at: "2026-08-09T00:00:00.000Z",
							updated_at: "2026-08-09T00:00:00.000Z",
						};
					},
					async run() {
						return { meta: { changes: 1 } };
					},
				};
				return statement;
			},
		};

		await expect(makeBridge(db).contentCreate("posts", { slug: "created" })).resolves.toEqual(
			expect.objectContaining({ id: "created-id", type: "posts" }),
		);
		expect(queries).toHaveLength(3);
	});

	it("fails closed without exposing unexpected database errors", async () => {
		const db = {
			prepare() {
				return {
					bind() {
						return this;
					},
					async first() {
						throw new Error("private database failure");
					},
				};
			},
		};
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(
				makeBridge(db).contentCreate("posts", { slug: "blocked" }),
			).rejects.toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_CHECK_FAILED",
				message: "Unable to verify media usage activation state",
				status: 503,
			});
		} finally {
			consoleError.mockRestore();
		}
	});

	it.each([
		{
			name: "explicit locale",
			config: { defaultLocale: "en", locales: ["en", "zh-TW"] },
			options: { locale: "zh-tw" },
			expected: "zh-TW",
		},
		{
			name: "configured default",
			config: { defaultLocale: "ja", locales: ["ja"] },
			options: undefined,
			expected: "ja",
		},
		{
			name: "no-i18n fallback",
			config: null,
			options: undefined,
			expected: "en",
		},
	])("persists the $name", async ({ config, options, expected }) => {
		const statements: Array<{ sql: string; values: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				const statement = {
					values: [] as unknown[],
					bind(...values: unknown[]) {
						statement.values = values;
						statements.push({ sql, values });
						return statement;
					},
					async first() {
						if (sql.includes("_emdash_media_usage_activation")) {
							throw new Error("D1_ERROR: no such table: _emdash_media_usage_activation");
						}
						return {
							id: "created-id",
							locale: expected,
							created_at: "2026-08-16T00:00:00.000Z",
							updated_at: "2026-08-16T00:00:00.000Z",
						};
					},
					async run() {
						return { meta: { changes: 1 } };
					},
				};
				return statement;
			},
		};

		const created = await makeBridge(db, config).contentCreate("posts", {}, options);
		const insert = statements.find(({ sql }) => sql.startsWith("INSERT INTO"));

		expect(insert?.sql).toContain('"locale"');
		expect(insert?.values).toContain(expected);
		expect(insert?.sql).toContain('"translation_group"');
		expect(insert?.values.at(-1)).toBe(insert?.values[0]);
		expect(created).toMatchObject({ locale: expected });
	});

	it("rejects invalid locale options before querying D1", async () => {
		const prepare = vi.fn();
		const bridge = makeBridge({ prepare }, { defaultLocale: "en", locales: ["en", "fr"] });

		await expect(bridge.contentCreate("posts", {}, { locale: "en_US" })).rejects.toThrow(
			/invalid locale code/i,
		);
		await expect(bridge.contentCreate("posts", {}, { locale: "de" })).rejects.toThrow(
			/not configured/i,
		);
		expect(prepare).not.toHaveBeenCalled();
	});
});
