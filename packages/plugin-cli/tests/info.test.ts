import { describe, expect, it, vi } from "vitest";

import { getLatestReleaseForInfo } from "../src/commands/info.js";

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
