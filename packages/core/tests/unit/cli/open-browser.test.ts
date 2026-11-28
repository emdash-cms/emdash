import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { getBrowserCommand } from "../../../src/cli/open-browser.js";

const PLATFORMS = ["darwin", "win32", "linux"] as const;

describe("getBrowserCommand", () => {
	it.each(PLATFORMS)("opens an http(s) URL on %s", (platform) => {
		for (const url of [
			"https://example.com/_emdash/admin/device",
			"http://localhost:4321/_emdash/admin/device",
		]) {
			expect(getBrowserCommand(url, platform)?.args.at(-1)).toBe(url);
		}
	});

	it.each(PLATFORMS)("opens nothing for a non-web address on %s", (platform) => {
		for (const target of [
			"file:///tmp/notes.txt",
			"mailto:someone@example.com",
			"/tmp/notes.txt",
			"C:\\Users\\Public\\notes.txt",
			"--help",
			"",
			undefined,
			{ href: "https://example.com/" },
		]) {
			expect(getBrowserCommand(target, platform)).toBeNull();
		}
	});

	it("passes the whole URL, including query separators, on Windows", () => {
		const url = "https://example.com/device?a=1&b=2%20c";
		const command = getBrowserCommand(url, "win32");

		expect(command?.args.at(-1)).toBe(url);
	});

	it("launches rundll32 by absolute path on Windows", () => {
		const file = getBrowserCommand("https://example.com/", "win32")?.file ?? "";

		expect(win32.isAbsolute(file)).toBe(true);
		expect(win32.basename(file).toLowerCase()).toBe("rundll32.exe");
	});

	it("passes a URL with spaces or quotes as a single unquoted argument", () => {
		for (const platform of PLATFORMS) {
			const command = getBrowserCommand('https://example.com/a b"c?d e"f#g h"i', platform);

			expect(command?.args.at(-1)).not.toMatch(/[\s"]/);
		}
	});
});
