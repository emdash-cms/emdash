import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT = 4407;
const TIMEOUT = 180_000;

describe("Public redirect integration", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });

		const response = await fetch(`${ctx.baseUrl}/_emdash/api/redirects`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
			},
			body: JSON.stringify({
				source: "/legacy-landing/",
				destination: "/",
				type: 301,
				enabled: true,
				groupName: "test",
			}),
		});

		expect(response.status).toBe(201);
	}, TIMEOUT);

	afterAll(async () => {
		await ctx?.cleanup();
	});

	it("applies redirects for anonymous public requests", async () => {
		const response = await fetch(`${ctx.baseUrl}/legacy-landing/`, {
			redirect: "manual",
		});

		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe("/");
	});
});
