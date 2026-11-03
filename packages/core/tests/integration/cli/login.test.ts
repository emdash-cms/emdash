import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Answers discovery without a device flow, so `login` stops before opening a browser. */
function startStub(): Promise<{ server: Server; seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		const path = req.url ?? "";
		seen.push(path);
		res.writeHead(200, { "content-type": "application/json" });
		if (path === "/_emdash/.well-known/auth") {
			res.end(JSON.stringify({ instance: { name: "Stub" }, auth: { methods: {} } }));
			return;
		}
		res.end("{}");
	});
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, seen })));
}

function urlOf(server: Server): string {
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((done) => server.close(() => done()));
}

describe("emdash login and logout", () => {
	let workDir: string;
	let stub: { server: Server; seen: string[] } | undefined;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "emdash-login-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		if (stub) await closeServer(stub.server);
		stub = undefined;
	});

	function saveCredential(url: string): void {
		const dir = join(workDir, "config", "emdash");
		mkdirSync(dir, { recursive: true });
		const credential = {
			accessToken: "a",
			refreshToken: "r",
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		};
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ [url]: credential }));
	}

	function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
		const baseEnv: NodeJS.ProcessEnv = {
			...process.env,
			XDG_CONFIG_HOME: join(workDir, "config"),
			NO_COLOR: "1",
		};
		delete baseEnv.EMDASH_TOKEN;
		delete baseEnv.EMDASH_URL;
		delete baseEnv.EMDASH_HEADERS;
		return new Promise((done) => {
			execFile(
				"node",
				[CLI_BIN, ...args],
				{ cwd: workDir, env: { ...baseEnv, ...env }, timeout: 15_000 },
				(error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
					done({ code, stdout, stderr });
				},
			);
		});
	}

	it("login uses EMDASH_URL when --url is not given", async () => {
		const { server, seen } = (stub = await startStub());

		const result = await runCli(["login"], { EMDASH_URL: urlOf(server) });

		expect(seen).toContain("/_emdash/.well-known/auth");
		expect(result.code).toBe(0);
	});

	it("logout uses EMDASH_URL when --url is not given", async () => {
		const { server, seen } = (stub = await startStub());
		saveCredential(urlOf(server));

		const result = await runCli(["logout"], { EMDASH_URL: urlOf(server) });

		expect(seen).toContain("/_emdash/api/oauth/token/revoke");
		expect(result.code).toBe(0);
		const stored = JSON.parse(readFileSync(join(workDir, "config", "emdash", "auth.json"), "utf8"));
		expect(stored[urlOf(server)]).toBeUndefined();
	});
});
