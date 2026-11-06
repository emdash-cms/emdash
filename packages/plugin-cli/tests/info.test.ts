import { describe, expect, it, vi } from "vitest";

import { getLatestReleaseForInfo, hasVisibleReleaseForInfo } from "../src/commands/info.js";

describe("plugin info latest release", () => {
	it("keeps package info available when the release lookup fails", async () => {
		await expect(
			getLatestReleaseForInfo("1.2.3", async () => {
				throw new Error("aggregator unavailable");
			}),
		).resolves.toBeNull();
	});

	it("does not query releases when the package has no latest version", async () => {
		const lookup = vi.fn();

		await expect(getLatestReleaseForInfo(null, lookup)).resolves.toBeNull();
		expect(lookup).not.toHaveBeenCalled();
	});
});

describe("plugin info release visibility", () => {
	it("finds an exact visible version across release pages", async () => {
		const lookup = vi
			.fn()
			.mockResolvedValueOnce({ releases: [{ version: "2.0.0" }], cursor: "next" })
			.mockResolvedValueOnce({ releases: [{ version: "1.0.0" }] });

		await expect(hasVisibleReleaseForInfo("1.0.0", lookup)).resolves.toBe(true);
		expect(lookup).toHaveBeenNthCalledWith(1, undefined);
		expect(lookup).toHaveBeenNthCalledWith(2, "next");
	});

	it("returns false after the final release page", async () => {
		const lookup = vi.fn(async () => ({ releases: [{ version: "2.0.0" }] }));

		await expect(hasVisibleReleaseForInfo("1.0.0", lookup)).resolves.toBe(false);
	});
});
