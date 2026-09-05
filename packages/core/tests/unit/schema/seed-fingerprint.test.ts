import { describe, it, expect } from "vitest";

import { buildSeedCollectionCaptureFingerprint } from "../../../src/schema/registry.js";

describe("seed collection capture fingerprint", () => {
	const input = { slug: "posts", label: "Posts" };

	it("is unchanged by the default edit-locking setting", async () => {
		const bare = await buildSeedCollectionCaptureFingerprint(input, []);

		expect(await buildSeedCollectionCaptureFingerprint({ ...input, editLocking: true }, [])).toBe(
			bare,
		);
	});

	it("changes when edit locking is switched off", async () => {
		const bare = await buildSeedCollectionCaptureFingerprint(input, []);

		expect(
			await buildSeedCollectionCaptureFingerprint({ ...input, editLocking: false }, []),
		).not.toBe(bare);
	});
});
