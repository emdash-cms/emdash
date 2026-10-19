import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { AI: { run: vi.fn() } } }));

vi.mock("@flue/runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@flue/runtime")>()),
	listRuns: vi.fn(async () => ({ runs: [] })),
}));

const { default: app } = await import("../.flue/app.js");

describe("GET /webhook/admin/runs", () => {
	it("rejects every request when the webhook secret is unset", async () => {
		const res = await app.request("/webhook/admin/runs", {}, {});
		expect(res.status).toBe(401);
	});

	it("rejects a wrong token and accepts the webhook secret", async () => {
		const env = { GITHUB_WEBHOOK_SECRET: "secret" };
		const wrong = await app.request(
			"/webhook/admin/runs",
			{ headers: { "x-admin-token": "nope" } },
			env,
		);
		expect(wrong.status).toBe(401);
		const right = await app.request(
			"/webhook/admin/runs",
			{ headers: { "x-admin-token": "secret" } },
			env,
		);
		expect(right.status).toBe(200);
	});
});
