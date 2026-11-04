import { afterEach, beforeEach } from "vitest";

import { createBridgeHandler } from "../../../../workerd/src/sandbox/bridge-handler.js";
import {
	ATTRIBUTION_COLLECTION,
	type ContentAttributionAccess,
	type ContentAttributionFixture,
	registerContentAttributionTests,
	seedContentAttribution,
} from "../../utils/plugin-content-attribution.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describeEachDialect("Workerd bridge content attribution", (dialect) => {
	let ctx: DialectTestContext;
	let fixture: ContentAttributionFixture;
	let access: ContentAttributionAccess;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		fixture = await seedContentAttribution(ctx.db);
		const handler = createBridgeHandler({
			pluginId: "attribution-plugin",
			version: "1.0.0",
			capabilities: ["read:content", "write:content"],
			allowedHosts: [],
			storageCollections: [],
			db: ctx.db,
			emailSend: () => null,
		});

		async function invoke<T>(method: string, body: Record<string, unknown>): Promise<T> {
			const response = await handler(
				new Request(`http://bridge/content/${method}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ collection: ATTRIBUTION_COLLECTION, ...body }),
				}),
			);
			const envelope = (await response.json()) as { result: T; error?: string };
			if (envelope.error) throw new Error(envelope.error);
			return envelope.result;
		}

		access = {
			create: (data) => invoke("create", { data }),
			update: (id, data) => invoke("update", { id, data }),
			get: (id) => invoke("get", { id }),
			list: () => invoke("list", {}),
			createMany: (items) => invoke("createMany", { items }),
		};
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	registerContentAttributionTests(() => ({ fixture, access }), true);
});
