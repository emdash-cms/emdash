import { describe, expect, it } from "vitest";

import { browserOpenCommand } from "../../../src/cli/open-browser.js";

// The device-flow `verification_uri` is whatever the remote instance returns,
// so it may carry characters that cmd.exe treats as syntax while still being a
// valid URL without whitespace.
const HOSTILE_URL = "https://cms.example/_emdash/device&a|b%c%";
const LOGIN_URL = "https://cms.example/_emdash/admin/device";

describe("browserOpenCommand", () => {
	it("never routes a URL through cmd.exe on Windows", () => {
		const command = browserOpenCommand(HOSTILE_URL, "win32");
		expect(command?.file).toBe("rundll32");
		expect(command?.args).toEqual(["url.dll,FileProtocolHandler", HOSTILE_URL]);
	});

	it("passes the URL as one argument on macOS and Linux", () => {
		for (const url of [LOGIN_URL, HOSTILE_URL]) {
			expect(browserOpenCommand(url, "darwin")).toEqual({ file: "open", args: [url] });
			expect(browserOpenCommand(url, "linux")).toEqual({ file: "xdg-open", args: [url] });
		}
	});

	it("opens the re-serialised URL", () => {
		expect(browserOpenCommand("  HTTPS://cms.example/a b", "win32")?.args).toEqual([
			"url.dll,FileProtocolHandler",
			"https://cms.example/a%20b",
		]);
	});

	it("refuses a host that would make Node quote the argument", () => {
		for (const url of ['https://a"b.example/', "https://a%22b.example/"]) {
			expect(browserOpenCommand(url, "win32")).toBeNull();
			expect(browserOpenCommand(url, "linux")).toBeNull();
		}
	});

	it("refuses anything that is not an http(s) URL", () => {
		for (const url of ["file:///C:/Windows/System32/calc.exe", "ms-settings:network", "nope", ""]) {
			expect(browserOpenCommand(url, "win32")).toBeNull();
			expect(browserOpenCommand(url, "linux")).toBeNull();
		}
	});
});
