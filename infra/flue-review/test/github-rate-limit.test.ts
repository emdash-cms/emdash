import { afterEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
	mintInstallationToken: vi.fn(),
	readAppCreds: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;

		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("../.flue/lib/github.js", () => github);

import { GitHubRateLimitDO } from "../.flue/lib/github-rate-limit.js";

class MemoryStorage {
	values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return structuredClone(this.values.get(key)) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.values.set(key, structuredClone(value));
	}
}

function coordinator(storage = new MemoryStorage()) {
	const ctx = { storage };
	return {
		storage,
		gate: new GitHubRateLimitDO(ctx as unknown as DurableObjectState, {} as unknown as Env),
	};
}

describe("GitHubRateLimitDO", () => {
	afterEach(() => vi.clearAllMocks());

	it("keeps a reset in storage and suppresses every caller until it passes", async () => {
		const now = Date.now();
		const { storage, gate } = coordinator();
		await gate.record("issue:get", "consumer-a", {
			status: 403,
			limit: 5_000,
			remaining: 0,
			resetAt: now + 120_000,
			retryAfterAt: now + 60_000,
		});

		const initial = await gate.permit("graphql", "consumer-b");
		expect(initial.allowed).toBe(false);
		expect(initial.retryAt).toBeGreaterThanOrEqual(now + 120_000);

		const afterEviction = await coordinator(storage).gate.permit("graphql", "emdash-flue-review");
		expect(afterEviction).toEqual(initial);
	});

	it("adds bounded release jitter only after the reset boundary", async () => {
		const now = Date.now();
		const { gate } = coordinator();
		await gate.record("graphql", "consumer", {
			status: 429,
			limit: 5_000,
			remaining: 0,
			resetAt: now + 30_000,
			retryAfterAt: null,
		});
		const state = await gate.inspect();
		expect(state).not.toBeNull();
		expect(state?.nextPermitAt).toBeGreaterThanOrEqual(state?.backoffUntil ?? 0);
		expect((state?.nextPermitAt ?? 0) - (state?.backoffUntil ?? 0)).toBeLessThanOrEqual(5_000);
	});

	it("reserves every successful permit so one consumer cannot burst", async () => {
		const { storage, gate } = coordinator();
		await storage.put("installation-rate-limit", {
			backoffUntil: 0,
			nextPermitAt: Date.now() - 1,
			limit: 5_000,
			remaining: 5_000,
			resetAt: Date.now() + 60 * 60_000,
		});

		expect(await gate.permit("issue:get", "review:1")).toMatchObject({ allowed: true });
		const sameConsumer = await gate.permit("issue:get", "review:1");
		const otherConsumer = await gate.permit("issue:get", "review:2");
		expect(sameConsumer).toMatchObject({ allowed: false });
		expect(otherConsumer).toEqual(sameConsumer);
		expect(await gate.inspect()).toMatchObject({
			remaining: 4_999,
			nextPermitAt: sameConsumer.retryAt,
		});
	});

	it("paces from successful response headers before GitHub rejects a request", async () => {
		const now = Date.now();
		const { gate } = coordinator();
		await gate.record("graphql", "consumer", {
			status: 200,
			limit: 5_000,
			remaining: 100,
			resetAt: now + 60_000,
			retryAfterAt: null,
		});

		const permit = await gate.permit("issue:get", "another-consumer");
		expect(permit.allowed).toBe(false);
		expect(permit.retryAt).toBeGreaterThanOrEqual(now + 600);
	});

	it("mints one installation token for concurrent callers and reuses it until it expires", async () => {
		github.readAppCreds.mockReturnValue({ appId: "1", privateKeyPem: "pem", installationId: "2" });
		github.mintInstallationToken.mockResolvedValue("minted-token");
		const { storage, gate } = coordinator();

		await expect(
			Promise.all([gate.getInstallationToken(), gate.getInstallationToken()]),
		).resolves.toEqual(["minted-token", "minted-token"]);
		await expect(gate.getInstallationToken()).resolves.toBe("minted-token");
		expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);

		await storage.put("installation-token", { token: "old", expiresAt: Date.now() - 1 });
		github.mintInstallationToken.mockResolvedValue("fresh-token");
		await expect(gate.getInstallationToken()).resolves.toBe("fresh-token");
	});

	it("serves permit, record and token requests over fetch", async () => {
		github.readAppCreds.mockReturnValue({ appId: "1", privateKeyPem: "pem", installationId: "2" });
		github.mintInstallationToken.mockResolvedValue("minted-token");
		const { gate } = coordinator();
		const post = (path: string, body: unknown) =>
			gate.fetch(
				new Request(`http://github-rate-limit${path}`, {
					method: "POST",
					body: JSON.stringify(body),
				}),
			);

		const permit = await post("/permit", { category: "graphql", consumer: "review" });
		expect(await permit.json()).toMatchObject({ allowed: true });
		const record = await post("/record", {
			category: "graphql",
			consumer: "review",
			metadata: { status: 200, limit: 5_000, remaining: 4_000, resetAt: null, retryAfterAt: null },
		});
		expect(record.status).toBe(204);
		expect(await gate.inspect()).toMatchObject({ limit: 5_000, remaining: 4_000 });
		const token = await gate.fetch(new Request("http://github-rate-limit/token"));
		expect(await token.json()).toEqual({ token: "minted-token" });
		expect((await post("/permit", { category: "graphql" })).status).toBe(400);
	});
});
