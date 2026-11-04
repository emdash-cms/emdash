import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

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

const API_TOKEN = "ec_pat_test";
const SERVICE_TOKEN_ID = "client-id-test";
const SERVICE_TOKEN_SECRET = "client-secret-test";
const ACCESS_JWT = "cf-jwt-test";

interface CliOutput {
	code: number | null;
	output: string;
}

/** An instance with external auth: no device flow, one accepted API token, optionally behind Access. */
function startExternalAuthInstance(behindAccess: boolean): Promise<{
	server: Server;
	authorized: string[];
}> {
	const authorized: string[] = [];
	const server = createServer((req, res) => {
		const path = req.url ?? "";
		res.setHeader("content-type", "application/json");
		// The Location matches the CLI's Access login pattern but stays on this server,
		// so a client that follows the redirect never leaves the machine.
		if (path.startsWith("/x.cloudflareaccess.com/")) {
			res.writeHead(403);
			res.end("{}");
			return;
		}
		const passesAccess =
			(req.headers["cf-access-client-id"] === SERVICE_TOKEN_ID &&
				req.headers["cf-access-client-secret"] === SERVICE_TOKEN_SECRET) ||
			req.headers["cf-access-token"] === ACCESS_JWT;
		if (behindAccess && !passesAccess) {
			res.writeHead(302, {
				location: `http://${req.headers.host}/x.cloudflareaccess.com/cdn-cgi/access/login`,
			});
			res.end();
			return;
		}
		if (path === "/_emdash/.well-known/auth") {
			res.end(
				JSON.stringify({
					instance: { name: "Stub" },
					auth: { mode: "external", methods: { api_tokens: true } },
				}),
			);
			return;
		}
		if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
			res.writeHead(401);
			res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "" } }));
			return;
		}
		authorized.push(path);
		res.end(JSON.stringify({ data: { items: [] } }));
	});
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, authorized })));
}

function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

describe("emdash login without device flow", () => {
	let workDir: string;
	let binDir: string;
	let instance: { server: Server; authorized: string[] } | undefined;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "emdash-login-"));
		binDir = join(workDir, "bin");
		mkdirSync(binDir);
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		if (instance) {
			const { server } = instance;
			await new Promise<void>((done) => server.close(() => done()));
		}
		instance = undefined;
	});

	/** A cloudflared on PATH that has a cached Access session for `origin` and nothing else. */
	function installCloudflared(origin: string): void {
		const script = join(binDir, "cloudflared");
		writeFileSync(
			script,
			[
				"#!/bin/sh",
				`if [ "$1 $2 $3 $4" = "access token -app ${origin}" ]; then echo ${ACCESS_JWT}; exit 0; fi`,
				"exit 1",
				"",
			].join("\n"),
		);
		chmodSync(script, 0o755);
	}

	function run(file: string, args: string[]): Promise<CliOutput> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			XDG_CONFIG_HOME: join(workDir, "config"),
			NODE_ENV: "production",
			TEST: "",
			NO_COLOR: "1",
		};
		delete env.EMDASH_TOKEN;
		delete env.EMDASH_URL;
		delete env.EMDASH_HEADERS;
		return new Promise((done) => {
			execFile(file, args, { cwd: workDir, env, timeout: 15_000 }, (error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
				done({ code, output: `${stdout}${stderr}` });
			});
		});
	}

	it.each([
		{ site: "a site", behindAccess: false, loginHeaders: [] },
		{
			site: "a site behind Access, logged in with a service token",
			behindAccess: true,
			loginHeaders: [
				"-H",
				`CF-Access-Client-Id: ${SERVICE_TOKEN_ID}`,
				"-H",
				`CF-Access-Client-Secret: ${SERVICE_TOKEN_SECRET}`,
			],
		},
		{
			site: "a site behind Access, logged in through cloudflared",
			behindAccess: true,
			loginHeaders: [],
		},
	])(
		"prints guidance that leads to an authorized request on $site",
		async ({ behindAccess, loginHeaders }) => {
			instance = await startExternalAuthInstance(behindAccess);
			const baseUrl = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
			installCloudflared(baseUrl);

			const login = await run("node", [CLI_BIN, "login", "--url", baseUrl, ...loginHeaders]);
			const suggested = login.output.match(/\bemdash (.*<token>.*)$/m)?.[1];
			expect(suggested, login.output).toBeDefined();

			const command = [
				"node",
				shellQuote(CLI_BIN),
				...suggested!
					.trim()
					.split(/\s+/)
					.map((arg) => shellQuote(arg === "<token>" ? API_TOKEN : arg)),
			];
			if (/same --header flags/.test(login.output)) {
				command.push(...loginHeaders.map(shellQuote));
			}
			const accessHeader = login.output.match(/-H "cf-access-token: \$\(cloudflared [^)]*\)"/)?.[0];
			if (accessHeader) {
				command.push(accessHeader);
			}
			const result = await run("sh", ["-c", command.join(" ")]);

			expect(instance.authorized, `${login.output}\n${result.output}`).not.toEqual([]);
			expect(result.code).toBe(0);
		},
	);
});
