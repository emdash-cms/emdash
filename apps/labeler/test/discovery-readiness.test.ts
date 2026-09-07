import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("discovery readiness", () => {
	it("reports configured but not ready before the scheduled discovery loop starts", async () => {
		const discovery = env.LABELER_DISCOVERY_DO.getByName("readiness");
		expect(await discovery.status()).toEqual({
			configured: true,
			running: false,
			ready: false,
			cursor: null,
			consecutiveFailures: 0,
			reason: "awaiting-start",
		});
	});
});
