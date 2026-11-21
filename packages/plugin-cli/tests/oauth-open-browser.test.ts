import { describe, expect, it } from "vitest";

import { browserOpenCommand } from "../src/oauth.js";

// The shape of the authorization URL the CLI opens: the OAuth library appends
// `client_id` and `request_uri`, so every login URL contains `&`.
const LOGIN_URL =
	"https://bsky.social/oauth/authorize?client_id=https%3A%2F%2Fexample.com%2Fclient&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Areq-123";

// An authorization server controls its own `authorization_endpoint`, so the
// path may carry characters that cmd.exe treats as syntax while still being a
// valid URL without whitespace.
const HOSTILE_URL = "https://as.example/authorize&a|b%c%?client_id=c&request_uri=r";

describe("browserOpenCommand", () => {
	it("never routes a URL through cmd.exe on Windows", () => {
		const command = browserOpenCommand(LOGIN_URL, "win32");
		expect(command).not.toBeNull();
		expect(command?.file).not.toBe("cmd");
		expect(command?.args).not.toContain("/c");
		expect(command?.args).not.toContain("start");
	});

	it("passes the whole URL as a single argument on Windows", () => {
		const command = browserOpenCommand(HOSTILE_URL, "win32");
		expect(command?.file).toBe("rundll32");
		expect(command?.args).toEqual(["url.dll,FileProtocolHandler", HOSTILE_URL]);
	});

	it("keeps the URL intact as one argument on every platform", () => {
		for (const url of [LOGIN_URL, HOSTILE_URL]) {
			for (const platform of ["win32", "darwin", "linux"] as const) {
				const command = browserOpenCommand(url, platform);
				expect(command?.args.at(-1)).toBe(url);
				expect(command?.args).toHaveLength(platform === "win32" ? 2 : 1);
			}
		}
	});

	it("opens the re-serialised URL", () => {
		expect(
			browserOpenCommand("  HTTPS://as.example/authorize?client_id=a b", "win32")?.args,
		).toEqual(["url.dll,FileProtocolHandler", "https://as.example/authorize?client_id=a%20b"]);
	});

	it("refuses a host that would make Node quote the argument", () => {
		for (const url of ['https://a"b.example/authorize', "https://a%22b.example/authorize"]) {
			for (const platform of ["win32", "darwin", "linux"] as const) {
				expect(browserOpenCommand(url, platform)).toBeNull();
			}
		}
	});

	it("uses the native opener on macOS and Linux", () => {
		expect(browserOpenCommand(LOGIN_URL, "darwin")).toEqual({ file: "open", args: [LOGIN_URL] });
		expect(browserOpenCommand(LOGIN_URL, "linux")).toEqual({
			file: "xdg-open",
			args: [LOGIN_URL],
		});
	});

	it("refuses anything that is not an http(s) URL", () => {
		for (const url of [
			"file:///C:/Windows/System32/calc.exe",
			"javascript:alert(1)",
			"ms-settings:network",
			"mailto:someone@example.com",
			"not a url",
			"",
		]) {
			expect(browserOpenCommand(url, "win32")).toBeNull();
			expect(browserOpenCommand(url, "darwin")).toBeNull();
			expect(browserOpenCommand(url, "linux")).toBeNull();
		}
	});
});
