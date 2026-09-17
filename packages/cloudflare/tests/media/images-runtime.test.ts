import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: {} as Record<string, string | undefined> }));

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));

import { createMediaProvider } from "../../src/media/images-runtime.js";

function thumbnailUrl(provider: ReturnType<typeof createMediaProvider>, id: string): string {
	const getThumbnailUrl = provider.getThumbnailUrl;
	if (!getThumbnailUrl) throw new Error("Images provider does not implement getThumbnailUrl");
	return getThumbnailUrl(id);
}

/** The account-hash path segment in a Cloudflare Images delivery URL. */
function accountHashFrom(url: string): string {
	return new URL(url).pathname.split("/")[1] ?? "";
}

describe("cloudflare images credential resolution", () => {
	const originalAccountHash = process.env.CF_IMAGES_ACCOUNT_HASH;

	afterEach(() => {
		for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
		if (originalAccountHash === undefined) delete process.env.CF_IMAGES_ACCOUNT_HASH;
		else process.env.CF_IMAGES_ACCOUNT_HASH = originalAccountHash;
	});

	it("falls back to process.env when no Workers binding is set", () => {
		process.env.CF_IMAGES_ACCOUNT_HASH = "node-hash";

		const provider = createMediaProvider({});
		expect(accountHashFrom(thumbnailUrl(provider, "img-id"))).toBe("node-hash");
	});

	it("prefers the Workers binding over process.env", () => {
		fakeEnv.CF_IMAGES_ACCOUNT_HASH = "workers-hash";
		process.env.CF_IMAGES_ACCOUNT_HASH = "node-hash";

		const provider = createMediaProvider({});
		expect(accountHashFrom(thumbnailUrl(provider, "img-id"))).toBe("workers-hash");
	});

	it("prefers a direct config value over both the Workers binding and process.env", () => {
		fakeEnv.CF_IMAGES_ACCOUNT_HASH = "workers-hash";
		process.env.CF_IMAGES_ACCOUNT_HASH = "node-hash";

		const provider = createMediaProvider({ accountHash: "direct-hash" });
		expect(accountHashFrom(thumbnailUrl(provider, "img-id"))).toBe("direct-hash");
	});

	it("throws the existing missing-variable error when neither source has the value", () => {
		const provider = createMediaProvider({});
		expect(() => thumbnailUrl(provider, "img-id")).toThrow("Missing CF_IMAGES_ACCOUNT_HASH");
	});
});
