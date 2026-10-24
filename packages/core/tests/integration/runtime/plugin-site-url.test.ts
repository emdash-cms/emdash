import { randomUUID } from "node:crypto";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { _resetEnvCache } from "../../../src/api/public-url.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { dispatchPluginApiRequest } from "../../../src/plugins/http-route-dispatch.js";

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	vi.stubEnv("EMDASH_SITE_URL", "");
	vi.stubEnv("SITE_URL", "");
	_resetEnvCache();
});

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	vi.unstubAllEnvs();
	_resetEnvCache();
});

async function pluginSiteUrl(
	options: Record<string, string>,
	config: { siteUrl?: string } = {},
): Promise<string> {
	const sqlite = new Database(":memory:");
	const setupDb = new Kysely<EmDashDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
	await runMigrations(setupDb);
	const repo = new OptionsRepository(setupDb);
	await repo.set("emdash:setup_complete", true);
	for (const [name, value] of Object.entries(options)) await repo.set(name, value);

	const runtime = await EmDashRuntime.create({
		config: {
			...config,
			database: { entrypoint: randomUUID(), config: {}, type: "sqlite" },
		},
		plugins: [
			definePlugin({
				id: "site-url-probe",
				version: "1.0.0",
				routes: { site: { public: true, handler: async (ctx) => ({ url: ctx.site.url }) } },
			}),
		],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	});
	cleanups.push(async () => {
		await runtime.shutdown();
		await setupDb.destroy();
	});

	const response = await dispatchPluginApiRequest({
		runtime,
		pluginId: "site-url-probe",
		path: "/site",
		request: new Request("https://request.example/_emdash/api/plugins/site-url-probe/site", {
			method: "POST",
		}),
	});
	const body = (await response.json()) as { data: { url: string } };
	return body.data.url;
}

describe("plugin ctx.site.url", () => {
	it("uses the Site URL setting after the site moved off its setup origin", async () => {
		expect(
			await pluginSiteUrl({
				"site:url": "https://new.example/",
				"emdash:site_url": "https://old.example",
			}),
		).toBe("https://new.example");
	});

	it("prefers the configured site URL over stored addresses", async () => {
		expect(
			await pluginSiteUrl(
				{ "site:url": "https://new.example", "emdash:site_url": "https://old.example" },
				{ siteUrl: "https://configured.example" },
			),
		).toBe("https://configured.example");
	});

	it("prefers EMDASH_SITE_URL over stored addresses", async () => {
		vi.stubEnv("EMDASH_SITE_URL", "https://env.example");

		expect(
			await pluginSiteUrl({
				"site:url": "https://new.example",
				"emdash:site_url": "https://old.example",
			}),
		).toBe("https://env.example");
	});

	it("falls back to the setup origin when the Site URL is not https", async () => {
		expect(
			await pluginSiteUrl({
				"site:url": "http://new.example",
				"emdash:site_url": "https://old.example",
			}),
		).toBe("https://old.example");
	});
});
