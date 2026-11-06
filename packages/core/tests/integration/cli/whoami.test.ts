import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

const ME = { id: "u1", email: "editor@example.com", name: null, role: 40 };

/** Answers like Cloudflare Access: an HTML login page unless `x-probe` is sent. */
function startStub(devBypassStatus = 403): Promise<{ server: Server; seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		const path = req.url ?? "";
		seen.push(path);
		if (path.startsWith("/_emdash/api/auth/dev-bypass")) {
			res.writeHead(devBypassStatus, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: "FORBIDDEN", message: "" } }));
			return;
		}
		if (!req.headers["x-probe"]) {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("<!DOCTYPE html><html>Sign in</html>");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: ME }));
	});
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, seen })));
}

function urlOf(server: Server): string {
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((done) => server.close(() => done()));
}

describe("emdash whoami", () => {
	let workDir: string;
	let stub: { server: Server; seen: string[] } | undefined;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "emdash-whoami-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		if (stub) await closeServer(stub.server);
		stub = undefined;
	});

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
				[CLI_BIN, "whoami", ...args],
				{ cwd: workDir, env: { ...baseEnv, ...env }, timeout: 15_000 },
				(error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
					done({ code, stdout, stderr });
				},
			);
		});
	}

	it.each<[string, string[], Record<string, string>]>([
		["EMDASH_HEADERS", [], { EMDASH_HEADERS: "X-Probe: env" }],
		["--header", ["--header", "X-Probe: flag"], {}],
	])("sends custom headers from %s", async (_source, extraArgs, env) => {
		stub = await startStub();

		const result = await runCli(
			["--url", urlOf(stub.server), "--token", "t", "--json", ...extraArgs],
			env,
		);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ email: ME.email, authMethod: "token" });
	});

	it("uses EMDASH_URL when --url is not given", async () => {
		const { server, seen } = (stub = await startStub());

		const result = await runCli(["--token", "t", "--json"], {
			EMDASH_URL: urlOf(server),
			EMDASH_HEADERS: "X-Probe: env",
		});

		expect(result.code).toBe(0);
		expect(seen).toContain("/_emdash/api/auth/me");
	});

	it("fails when nothing is listening on localhost", async () => {
		const closed = await startStub();
		const url = urlOf(closed.server);
		await closeServer(closed.server);

		const result = await runCli(["--url", url]);

		expect(result.code).toBe(1);
	});

	it.each([
		[403, "astro dev"],
		[404, "not available"],
	])("fails with guidance when the dev bypass answers %i", async (status, hint) => {
		stub = await startStub(status);

		const result = await runCli(["--url", urlOf(stub.server)]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(hint);
		expect(result.stderr).toContain("emdash login");
	});
});
