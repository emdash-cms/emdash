import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHILDREN_DIR } from "./helpers.js";

const BUILT_HOST = resolvePath(import.meta.dirname, "../../dist/rooms/node/index.mjs");

interface Child {
	/** Resolves to the first line of output that parses as JSON. */
	result: Promise<unknown>;
	output: () => string;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	kill: (signal: NodeJS.Signals) => void;
}

function run(script: string, args: string[] = []): Child {
	const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let resolveResult: (value: unknown) => void;
	let rejectResult: (error: Error) => void;
	const result = new Promise<unknown>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		for (const line of output.split("\n").slice(0, -1)) {
			if (line.startsWith("{") || line.startsWith("[")) resolveResult(JSON.parse(line));
		}
	});
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, signal) => {
			rejectResult(new Error(`The process exited without a result:\n${output}`));
			resolve({ code, signal });
		});
	});
	return { result, output: () => output, exited, kill: (signal) => child.kill(signal) };
}

describe("a process that holds room claims", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "emdash-hosts-"));
		path = join(dir, "site.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function claimHolder(): string | null | undefined {
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const row = db.prepare("SELECT host FROM _emdash_rooms WHERE part = 0").get() as
				| { host: string | null }
				| undefined;
			return row?.host;
		} finally {
			db.close();
		}
	}

	async function holding(args: string[] = []): Promise<Child> {
		const child = run(join(CHILDREN_DIR, "signals.mjs"), [path, ...args]);
		const ready = (await child.result) as { issued: string; host: string };
		expect(ready.issued).toBe("token");
		expect(claimHolder()).toBe(ready.host);
		return child;
	}

	it.each(["SIGTERM", "SIGINT"] as const)(
		"releases its claims on %s with no other handler, then stops from the signal",
		async (signal) => {
			const child = await holding();

			child.kill(signal);

			expect(await child.exited).toEqual({ code: null, signal });
			expect(claimHolder()).toBeNull();
		},
	);

	it("leaves stopping to another handler for the signal", async () => {
		const child = await holding(["--other-handler"]);

		child.kill("SIGTERM");

		expect(await child.exited).toEqual({ code: 0, signal: null });
		expect(child.output().match(/app handled SIGTERM/g)).toHaveLength(1);
		expect(claimHolder()).toBeNull();
	});
});

describe("a process with no server", () => {
	it("gives joins single-editor mode a minute after its first token, until a server is attached", async () => {
		const child = run(join(CHILDREN_DIR, "server-wait.mjs"));

		expect(await child.result).toEqual(["token", "token", null, "token"]);
		expect((await child.exited).code).toBe(0);
	});
});

describe("node:cluster", () => {
	it("gives a worker no host and no server watch, while its primary has both", async () => {
		const child = run(resolvePath(import.meta.dirname, "children/cluster.mjs"), [
			pathToFileURL(BUILT_HOST).href,
		]);

		expect(await child.result).toEqual({
			primary: { host: true, watching: true },
			worker: { host: false, watching: false },
		});
		expect((await child.exited).code).toBe(0);
	});
});
