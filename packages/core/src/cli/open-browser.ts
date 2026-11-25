/**
 * Best-effort browser launch for CLI sign-in flows.
 *
 * The URL to open comes from the site being signed in to, so only http(s)
 * URLs reach the operating system's opener.
 */

import { execFile } from "node:child_process";
import { win32 } from "node:path";

export interface BrowserCommand {
	file: string;
	args: string[];
}

/**
 * Build the command that opens `target` in the default browser.
 * Returns null when `target` is not an http(s) URL.
 */
export function getBrowserCommand(
	target: unknown,
	platform: NodeJS.Platform = process.platform,
): BrowserCommand | null {
	if (typeof target !== "string") return null;

	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;

	if (platform === "darwin") {
		return { file: "open", args: [url.href] };
	}
	if (platform === "win32") {
		// rundll32 receives the URL without a shell, so `&` and `%` pass through unchanged.
		const rundll32 = win32.join(
			process.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"rundll32.exe",
		);
		return { file: rundll32, args: ["url.dll,FileProtocolHandler", url.href] };
	}
	return { file: "xdg-open", args: [url.href] };
}

/**
 * Open `target` in the default browser without waiting for the opener.
 * Failure is non-fatal: the caller prints the URL for the user as well.
 */
export function openBrowser(target: unknown): void {
	const command = getBrowserCommand(target);
	if (!command) return;
	try {
		execFile(command.file, command.args);
	} catch {
		// Ignore — user can open manually
	}
}
