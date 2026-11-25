import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { getBrowserCommand } from "../src/oauth.js";

const PLATFORMS = ["darwin", "win32", "linux"] as const;
const AUTHORIZATION_URL =
	"https://bsky.social/oauth/authorize?client_id=http%3A%2F%2Flocalhost&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Areq-1";

describe("getBrowserCommand", () => {
	it.each(PLATFORMS)("opens the whole authorization URL on %s", (platform) => {
		const command = getBrowserCommand(AUTHORIZATION_URL, platform);

		expect(command?.args.at(-1)).toBe(AUTHORIZATION_URL);
	});

	it.each(PLATFORMS)("opens nothing for a non-web address on %s", (platform) => {
		for (const target of [
			"file:///tmp/notes.txt",
			"mailto:someone@example.com",
			"/tmp/notes.txt",
			"",
		]) {
			expect(getBrowserCommand(target, platform)).toBeNull();
		}
	});

	it("launches rundll32 by absolute path on Windows", () => {
		const file = getBrowserCommand(AUTHORIZATION_URL, "win32")?.file ?? "";

		expect(win32.isAbsolute(file)).toBe(true);
		expect(win32.basename(file).toLowerCase()).toBe("rundll32.exe");
	});
});
