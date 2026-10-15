import { afterEach, describe, expect, test, vi } from "vitest";

import { createWriteAccessResolver } from "../../.flue/lib/write-access.js";

const repo = { owner: "emdash-cms", repo: "emdash" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function permissionFetch(permissions: Record<string, string | number>) {
	return vi.fn<typeof fetch>((input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const login = /\/collaborators\/([^/]+)\/permission$/.exec(url)?.[1] ?? "";
		const permission = permissions[login];
		if (typeof permission === "number") return Promise.resolve(jsonResponse({}, permission));
		return Promise.resolve(jsonResponse({ permission: permission ?? "read" }));
	});
}

describe("write access", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("returns the logins with write or admin permission, lowercased", async () => {
		vi.stubGlobal(
			"fetch",
			permissionFetch({ danielmlr: "write", ascorbic: "admin", reporter: "read" }),
		);
		const writers = await createWriteAccessResolver().writers("token", repo, [
			"DanielMLR",
			"ascorbic",
			"reporter",
		]);
		expect([...writers].toSorted()).toEqual(["ascorbic", "danielmlr"]);
	});

	test("reuses a cached answer until it expires", async () => {
		const fetchMock = permissionFetch({ danielmlr: "write" });
		vi.stubGlobal("fetch", fetchMock);
		let now = 0;
		const resolver = createWriteAccessResolver({ ttlMs: 1_000, now: () => now });

		await resolver.writers("token", repo, ["danielmlr"]);
		await resolver.writers("token", repo, ["DANIELMLR"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		now = 1_001;
		await resolver.writers("token", repo, ["danielmlr"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("caches per repository", async () => {
		const fetchMock = permissionFetch({ danielmlr: "write" });
		vi.stubGlobal("fetch", fetchMock);
		const resolver = createWriteAccessResolver();

		await resolver.writers("token", repo, ["danielmlr"]);
		await resolver.writers("token", { owner: "emdash-cms", repo: "templates" }, ["danielmlr"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("recognises a maintainer however many other people commented first", async () => {
		const logins = Array.from({ length: 30 }, (_, index) => `commenter${index}`);
		vi.stubGlobal("fetch", permissionFetch({ commenter29: "write" }));

		await expect(createWriteAccessResolver().writers("token", repo, logins)).resolves.toEqual(
			new Set(["commenter29"]),
		);
	});

	test("skips bot accounts", async () => {
		const fetchMock = permissionFetch({});
		vi.stubGlobal("fetch", fetchMock);

		await createWriteAccessResolver().writers("token", repo, ["renovate[bot]"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("treats a failed lookup as unknown and retries it next time", async () => {
		const fetchMock = permissionFetch({ danielmlr: 502 });
		vi.stubGlobal("fetch", fetchMock);
		const resolver = createWriteAccessResolver();

		const writers = await resolver.writers("token", repo, ["danielmlr"]);
		expect(writers.size).toBe(0);
		await resolver.writers("token", repo, ["danielmlr"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
