import { afterAll, beforeAll, expect, it } from "vitest";

import { EmDashClient } from "../../../src/client/index.js";
import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

let ctx: TestServerContext;

beforeAll(async () => {
	assertNodeVersion();
	ctx = await createTestServer({
		port: 4405,
		env: { EMDASH_TEST_EXTERNAL_AUTH: "1" },
	});
});

afterAll(async () => {
	await ctx?.cleanup();
});

it("authenticates a credential-free dev client when external auth is configured", async () => {
	const anonymous = await fetch(`${ctx.baseUrl}/_emdash/api/schema/collections`);
	expect(anonymous.status).toBe(401);

	const client = new EmDashClient({ baseUrl: ctx.baseUrl, devBypass: true });
	const collections = await client.collections();
	expect(collections.map((collection) => collection.slug)).toEqual(
		expect.arrayContaining(["posts", "pages"]),
	);
});
