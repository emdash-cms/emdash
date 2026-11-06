import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { PluginBridge } from "../../../cloudflare/src/sandbox/bridge.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import {
	ATTRIBUTION_COLLECTION,
	type ContentAttributionAccess,
	type ContentAttributionFixture,
	registerContentAttributionTests,
	seedContentAttribution,
} from "../utils/plugin-content-attribution.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

describe("Cloudflare bridge content attribution on D1", () => {
	let db: Kysely<Database>;
	let fixture: ContentAttributionFixture;
	let access: ContentAttributionAccess;
	let ctx: ExecutionContext;

	beforeAll(() => {
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
		fixture = await seedContentAttribution(db);
		const bridgeContext = Object.assign(createExecutionContext(), {
			props: {
				pluginId: "attribution-plugin",
				pluginVersion: "1.0.0",
				capabilities: ["content:read", "content:write"],
				allowedHosts: [],
				storageCollections: [],
			},
		});
		ctx = bridgeContext;
		const bridge = new PluginBridge(bridgeContext, { DB: env.DB });
		access = {
			create: (data) => bridge.contentCreate(ATTRIBUTION_COLLECTION, data),
			update: (id, data) => bridge.contentUpdate(ATTRIBUTION_COLLECTION, id, data),
			get: (id) => bridge.contentGet(ATTRIBUTION_COLLECTION, id),
			list: () => bridge.contentList(ATTRIBUTION_COLLECTION, {}),
		};
	});

	afterEach(async () => {
		if (ctx) await waitOnExecutionContext(ctx);
	});

	afterAll(async () => {
		await db.destroy();
	});

	registerContentAttributionTests(() => ({ fixture, access }));
});
