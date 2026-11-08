/**
 * Resolve the process that opens `url` in the default browser, or `null` when
 * `url` is not an http(s) URL or its host contains `"`. The URL comes from the
 * remote EmDash instance the CLI is logging in to, so it is untrusted data and
 * must reach the opener as one opaque argument.
 *
 * Windows must not go through `cmd /c start`: cmd.exe re-parses its command
 * line, so `&`, `|`, `^` and `%…%` inside the URL become shell syntax.
 * `rundll32 url.dll,FileProtocolHandler` hands the URL to ShellExecute without
 * a command interpreter in between. The argument must also stay unquoted: Node
 * quotes one that contains a space, a tab or `"`. URL parsing drops tabs and
 * percent-encodes spaces and `"` everywhere except in the host, and a host
 * cannot hold a space, so a URL with `"` in its host is refused.
 */
export function browserOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return null;
	}
	const target = parsed.toString();
	if (target.includes('"')) {
		return null;
	}
	if (platform === "darwin") {
		return { file: "open", args: [target] };
	}
	if (platform === "win32") {
		return { file: "rundll32", args: ["url.dll,FileProtocolHandler", target] };
	}
	return { file: "xdg-open", args: [target] };
}

/**
 * Best-effort attempt to open `url` in the user's default browser. Failure is
 * non-fatal: the CLI prints the URL too, so the user can open it manually. The
 * spawned process is not awaited.
 */
export function tryOpenBrowser(url: string): void {
	void (async () => {
		try {
			const command = browserOpenCommand(url);
			if (!command) {
				return;
			}
			const { execFile } = await import("node:child_process");
			execFile(command.file, command.args);
		} catch {
			// Ignore — user can open manually
		}
	})();
}
