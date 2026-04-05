import { consola } from "consola";

interface OutputArgs {
	json?: boolean;
}

/**
 * Redirect consola output to stderr so it doesn't pollute JSON on stdout.
 *
 * Call this early in any command that uses `output()` with `--json`.
 * Safe to call multiple times — only applies the redirect once.
 */
export function configureOutputMode(args: OutputArgs): void {
	if (args.json || !process.stdout.isTTY) {
		// Send all consola output to stderr so stdout is clean JSON
		consola.options.stdout = process.stderr;
		consola.options.stderr = process.stderr;
	}
}

/**
 * Output data as JSON or pretty-printed.
 *
 * If stdout is not a TTY or --json is set, outputs JSON.
 * Otherwise, outputs a formatted representation.
 */
export function output(data: unknown, args: OutputArgs): void {
	const useJson = args.json || !process.stdout.isTTY;

	if (useJson) {
		// JSON output to stdout for piping
		process.stdout.write(JSON.stringify(data, null, 2) + "\n");
	} else {
		// Pretty output via consola
		prettyPrint(data);
	}
}

function prettyPrint(data: unknown, indent: number = 0): void {
	if (data === null || data === undefined) {
		consola.log("(empty)");
		return;
	}

	if (Array.isArray(data)) {
		if (data.length === 0) {
			consola.log("(no items)");
			return;
		}
		for (const item of data) {
			prettyPrint(item, indent);
			if (indent === 0) consola.log("---");
		}
		return;
	}

	if (typeof data === "object") {
		const obj = Object(data) as Record<string, unknown>;

		// Check if it's a list result with items
		if ("items" in obj && Array.isArray(obj.items)) {
			prettyPrint(obj.items, indent);
			if (typeof obj.nextCursor === "string") {
				consola.log(`\nNext cursor: ${obj.nextCursor}`);
			}
			return;
		}

		// Print object fields
		const prefix = "  ".repeat(indent);
		for (const [key, value] of Object.entries(obj)) {
			if (value === null || value === undefined) continue;
			if (typeof value === "object" && !Array.isArray(value)) {
				consola.log(`${prefix}${key}:`);
				prettyPrint(value, indent + 1);
			} else if (Array.isArray(value)) {
				consola.log(`${prefix}${key}: [${value.length} items]`);
			} else {
				const str = typeof value === "string" ? value : JSON.stringify(value);
				// Truncate long values
				const display = str.length > 80 ? str.slice(0, 77) + "..." : str;
				consola.log(`${prefix}${key}: ${display}`);
			}
		}
		return;
	}

	consola.log(typeof data === "string" ? data : JSON.stringify(data));
}
