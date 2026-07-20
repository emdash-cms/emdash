import { describe, expect, it, vi } from "vitest";

import { createSandboxRunnerOptions } from "../../../src/plugins/sandbox/runner-options.js";

describe("createSandboxRunnerOptions", () => {
	it("normalizes configured site information for sandbox contexts", () => {
		const db = {} as never;
		const options = createSandboxRunnerOptions(
			{ db },
			{
				siteName: "Example Site",
				siteUrl: "https://example.com/",
				locale: "nl",
			},
		);

		expect(options).toEqual({
			db,
			siteInfo: {
				name: "Example Site",
				url: "https://example.com",
				locale: "nl",
			},
		});
	});

	it("preserves runner options while applying site defaults", () => {
		const db = {} as never;
		const upload = vi.fn();
		const remove = vi.fn();
		const mediaStorage = { upload, delete: remove };
		const options = createSandboxRunnerOptions({ db, mediaStorage });

		expect(options.db).toBe(db);
		expect(options.mediaStorage).toBe(mediaStorage);
		expect(options.siteInfo).toEqual({ name: "", url: "", locale: "en" });
	});
});
