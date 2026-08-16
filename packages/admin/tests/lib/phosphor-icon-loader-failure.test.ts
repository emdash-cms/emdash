import { Plug } from "@phosphor-icons/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp } from "vitest/browser";

import { loadPhosphorIcon } from "../../src/lib/phosphor-icon-loader.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("loadPhosphorIcon failures", () => {
	it("returns Plug when an icon bucket cannot be loaded", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const session = cdp();
		await session.send("Network.enable");
		await session.send("Network.setBlockedURLs", {
			urls: ["*phosphor-icon-buckets/bucket-03.ts*"],
		});

		try {
			await expect(loadPhosphorIcon("Heart")).resolves.toBe(Plug);
			expect(error).toHaveBeenCalledWith(
				'[admin] Failed to load Phosphor icon "Heart":',
				expect.any(Error),
			);
		} finally {
			await session.send("Network.setBlockedURLs", { urls: [] });
		}
	});
});
