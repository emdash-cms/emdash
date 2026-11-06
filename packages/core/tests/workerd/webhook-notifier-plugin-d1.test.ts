import { env } from "cloudflare:workers";
import { parse as parseJsonc } from "jsonc-parser";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import manifestSource from "../../../plugins/webhook-notifier/emdash-plugin.jsonc?raw";
import webhookNotifier from "../../../plugins/webhook-notifier/src/plugin.js";
import type { PluginDescriptor } from "../../src/astro/integration/runtime.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { adaptSandboxEntry } from "../../src/plugins/adapt-sandbox-entry.js";
import { PluginContextFactory } from "../../src/plugins/context.js";
import type { ResolvedPlugin } from "../../src/plugins/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

interface WebhookNotifierManifest {
	slug: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<string, { indexes?: string[]; uniqueIndexes?: string[] }>;
}

function loadWebhookNotifierPlugin(): ResolvedPlugin {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest is validated by the plugin CLI; the test only reads the trust contract
	const manifest = parseJsonc(manifestSource) as WebhookNotifierManifest;
	const descriptor: PluginDescriptor = {
		id: manifest.slug,
		version: "0.0.0-test",
		entrypoint: "@emdash-cms/plugin-webhook-notifier/sandbox",
		format: "standard",
		capabilities: manifest.capabilities,
		allowedHosts: manifest.allowedHosts,
		storage: manifest.storage,
	};
	return adaptSandboxEntry(webhookNotifier, descriptor);
}

describe("webhook-notifier plugin on D1", () => {
	let db: Kysely<Database>;

	beforeAll(() => {
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("prunes a delivery backlog to the cap within D1's bound-parameter limit", async () => {
		const plugin = loadWebhookNotifierPlugin();
		const ctx = new PluginContextFactory({ db }).createContext(plugin);
		await ctx.kv.set("settings:webhookUrl", "http://localhost:8080/hook");
		const deliveries = ctx.storage.deliveries!;
		await deliveries.putMany(
			Array.from({ length: 650 }, (_, i) => ({
				id: `old-${i}`,
				data: {
					timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
					webhookUrl: "http://localhost:8080/hook",
					event: "content:update",
					status: "success",
				},
			})),
		);

		await plugin.hooks["content:afterDelete"]!.handler(
			{ id: "post-1", collection: "post", permanent: true },
			ctx,
		);

		expect(await deliveries.count()).toBe(500);
		const newest = await deliveries.query({ orderBy: { timestamp: "desc" }, limit: 1 });
		expect(newest.items[0]?.data).toMatchObject({ event: "content:delete", resourceId: "post-1" });
	});
});
