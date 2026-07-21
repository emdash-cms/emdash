import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

interface SiteCase {
	name: string;
	dir: string;
	port: number;
	startupTimeoutMs: number;
	waitPath?: string;
	setupPath?: string | null;
	frontendPath?: string;
	frontendStatuses?: number[];
	requireDoctype?: boolean;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const execAsync = promisify(execFile);
const FONT_FETCH_RETRY_IMPORT = pathToFileURL(
	resolve(import.meta.dirname, "retry-font-fetch.mjs"),
).href;

function nodeOptionsWithFontFetchRetry(): string {
	return [process.env.NODE_OPTIONS, `--import=${FONT_FETCH_RETRY_IMPORT}`]
		.filter(Boolean)
		.join(" ");
}

const SITE_MATRIX: SiteCase[] = [
	{
		name: "demos/playground",
		dir: resolve(WORKSPACE_ROOT, "demos/playground"),
		port: 4603,
		startupTimeoutMs: 120_000,
		waitPath: "/playground",
		frontendPath: "/playground",
		requireDoctype: false,
	},

	// Templates
	{
		name: "templates/blog",
		dir: resolve(WORKSPACE_ROOT, "templates/blog"),
		port: 4612,
		startupTimeoutMs: 60_000,
	},
	{
		name: "templates/blog-cloudflare",
		dir: resolve(WORKSPACE_ROOT, "templates/blog-cloudflare"),
		port: 4613,
		startupTimeoutMs: 120_000,
	},
	{
		name: "templates/marketing",
		dir: resolve(WORKSPACE_ROOT, "templates/marketing"),
		port: 4614,
		startupTimeoutMs: 90_000,
	},
	{
		name: "templates/marketing-cloudflare",
		dir: resolve(WORKSPACE_ROOT, "templates/marketing-cloudflare"),
		port: 4615,
		startupTimeoutMs: 120_000,
	},
	{
		name: "templates/portfolio",
		dir: resolve(WORKSPACE_ROOT, "templates/portfolio"),
		port: 4616,
		startupTimeoutMs: 90_000,
	},
	{
		name: "templates/portfolio-cloudflare",
		dir: resolve(WORKSPACE_ROOT, "templates/portfolio-cloudflare"),
		port: 4617,
		startupTimeoutMs: 120_000,
	},
	{
		name: "templates/starter-cloudflare",
		dir: resolve(WORKSPACE_ROOT, "templates/starter-cloudflare"),
		port: 4618,
		startupTimeoutMs: 120_000,
	},
];

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const res = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(3000),
			});
			if (res.status > 0) return;
		} catch {
			// retry
		}
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
	}

	throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function fetchWithRetry(url: string, retries = 10, delayMs = 1500): Promise<Response> {
	let lastError: unknown;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const res = await fetch(url, {
				redirect: "manual",
				signal: AbortSignal.timeout(15_000),
			});
			if (res.status < 500) return res;
			lastError = new Error(`${url} returned ${res.status}`);
		} catch (error) {
			lastError = error;
		}

		if (attempt < retries) {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
		}
	}

	throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

// ---------------------------------------------------------------------------
// Build verification — runs a single recursive `pnpm build` across templates
// and the playground demo in parallel. The child process imports a test-only
// fetch retry shim for Astro's remote Google font-file downloads so transient
// network errors don't make smoke tests flaky.
// ---------------------------------------------------------------------------

describe("Site build verification", () => {
	it("all templates and playground build successfully", { timeout: 300_000 }, async () => {
		await ensureBuilt();

		try {
			await execAsync(
				"pnpm",
				[
					"run",
					"--recursive",
					"--filter",
					"{./templates/*}",
					"--filter",
					"@emdash-cms/playground",
					"build",
				],
				{
					cwd: WORKSPACE_ROOT,
					timeout: 240_000,
					env: {
						...process.env,
						CI: "true",
						NODE_OPTIONS: nodeOptionsWithFontFetchRetry(),
					},
				},
			);
		} catch (error) {
			const stderr =
				error instanceof Error && "stderr" in error ? (error as { stderr: string }).stderr : "";
			const stdout =
				error instanceof Error && "stdout" in error ? (error as { stdout: string }).stdout : "";
			throw new Error(`Site builds failed:\n\n${stderr || stdout}`.slice(0, 5000), {
				cause: error,
			});
		}
	});
});

// ---------------------------------------------------------------------------
// Helpers — shared server lifecycle for runtime tests
// ---------------------------------------------------------------------------

interface BootedServer {
	baseUrl: string;
	process: ReturnType<typeof spawn>;
	output: string;
}

async function bootSite(site: SiteCase): Promise<BootedServer> {
	await ensureBuilt();

	// Remove stale database files so each run starts fresh.
	for (const file of ["data.db", "data.db-wal", "data.db-shm"]) {
		rmSync(join(site.dir, file), { force: true });
	}

	const baseUrl = `http://localhost:${site.port}`;
	const serverProcess = spawn("pnpm", ["exec", "astro", "dev", "--port", String(site.port)], {
		cwd: site.dir,
		env: {
			...process.env,
			CI: "true",
			NODE_OPTIONS: nodeOptionsWithFontFetchRetry(),
		},
		stdio: "pipe",
	});

	let output = "";
	serverProcess.stdout?.on("data", (data: Buffer) => {
		output += data.toString();
	});
	serverProcess.stderr?.on("data", (data: Buffer) => {
		output += data.toString();
	});

	const waitPath = site.waitPath ?? "/_emdash/admin/";
	await waitForServer(`${baseUrl}${waitPath}`, site.startupTimeoutMs);

	return {
		baseUrl,
		process: serverProcess,
		get output() {
			return output;
		},
	};
}

function killServer(serverProcess: ReturnType<typeof spawn>): Promise<void> {
	serverProcess.kill("SIGTERM");
	return new Promise((done) => {
		setTimeout(() => {
			if (!serverProcess.killed) {
				serverProcess.kill("SIGKILL");
			}
			setTimeout(done, 500);
		}, 1200);
	});
}

// ---------------------------------------------------------------------------
// Runtime verification — boots each site with `astro dev` and checks that
// admin + frontend respond.
// ---------------------------------------------------------------------------

describe.sequential("Site runtime verification", () => {
	for (const site of SITE_MATRIX) {
		const setupPath = site.setupPath ?? "/_emdash/api/setup/dev-bypass?redirect=/";
		const frontendPath = site.frontendPath ?? "/";
		const frontendStatuses = site.frontendStatuses ?? [200, 302, 307, 308];
		const requireDoctype = site.requireDoctype ?? true;

		it(
			`${site.name} boots and serves admin + frontend`,
			{ timeout: site.startupTimeoutMs + 120_000 },
			async () => {
				const server = await bootSite(site);

				try {
					if (setupPath) {
						const setupRes = await fetchWithRetry(`${server.baseUrl}${setupPath}`);
						expect(setupRes.status).toBeLessThan(500);
					}

					const adminRes = await fetchWithRetry(`${server.baseUrl}/_emdash/admin/`);
					expect(adminRes.status).toBeLessThan(500);

					const frontendRes = await fetchWithRetry(`${server.baseUrl}${frontendPath}`);
					expect(frontendStatuses).toContain(frontendRes.status);

					const body = await frontendRes.text();
					if (requireDoctype) {
						expect(body).toContain("<!DOCTYPE html>");
					}
				} catch (error) {
					throw new Error(
						`${site.name} smoke failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
							server.output.slice(-3000),
						{ cause: error },
					);
				} finally {
					await killServer(server.process);
				}
			},
		);
	}
});

// ---------------------------------------------------------------------------
// MCP endpoint verification — boots one Node and one Cloudflare site, gets a
// bearer token, and verifies the MCP server responds to tools/list.
// ---------------------------------------------------------------------------

const MCP_SITES: SiteCase[] = SITE_MATRIX.filter(
	(s) => s.name === "templates/blog" || s.name === "templates/starter-cloudflare",
);

const PLUGIN_MCP_SITE: SiteCase = {
	name: "demos/simple",
	dir: resolve(WORKSPACE_ROOT, "demos/simple"),
	port: 4620,
	startupTimeoutMs: 90_000,
};

describe.sequential("MCP endpoint verification", () => {
	for (const site of MCP_SITES) {
		it(
			`${site.name} MCP tools/list responds with tools`,
			{ timeout: site.startupTimeoutMs + 120_000 },
			async () => {
				const server = await bootSite(site);

				try {
					// Run dev-bypass with ?token=1 to get a bearer token
					const setupRes = await fetchWithRetry(
						`${server.baseUrl}/_emdash/api/setup/dev-bypass?token=1`,
					);
					expect(setupRes.status).toBeLessThan(500);

					const setupBody = (await setupRes.json()) as {
						data?: { token?: string };
					};
					const token = setupBody.data?.token;
					expect(token).toBeTruthy();

					// Send MCP initialize
					const initRes = await fetch(`${server.baseUrl}/_emdash/api/mcp`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json, text/event-stream",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							method: "initialize",
							params: {
								protocolVersion: "2025-03-26",
								capabilities: {},
								clientInfo: { name: "smoke-test", version: "1.0" },
							},
							id: 1,
						}),
					});
					expect(initRes.status).toBe(200);

					// Parse SSE response to extract JSON
					const initText = await initRes.text();
					const initData = parseSSE(initText);
					expect(initData).toHaveProperty("result.serverInfo.name", "emdash");

					// Send initialized notification + tools/list in one request
					// (stateless mode — each request is independent, so we send
					// the full sequence: notifications/initialized then tools/list)
					const listRes = await fetch(`${server.baseUrl}/_emdash/api/mcp`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json, text/event-stream",
							Authorization: `Bearer ${token}`,
						},
						body: JSON.stringify([
							{
								jsonrpc: "2.0",
								method: "notifications/initialized",
							},
							{
								jsonrpc: "2.0",
								method: "tools/list",
								params: {},
								id: 2,
							},
						]),
					});
					expect(listRes.status).toBe(200);

					const listText = await listRes.text();
					const listData = parseSSE(listText);
					expect(listData).toHaveProperty("result.tools");
					const tools = (listData as { result: { tools: unknown[] } }).result.tools;
					expect(tools.length).toBeGreaterThan(0);

					// Verify some expected tools exist
					const toolNames = tools.map((t: unknown) => (t as { name: string }).name);
					expect(toolNames).toContain("content_list");
					expect(toolNames).toContain("schema_list_collections");

					// Send 14 concurrent tools/list calls and verify all succeed —
					// guards against an auth-middleware race observed in production
					// where parallel requests on the same authenticated session
					// occasionally returned spurious 401s. The InMemoryTransport
					// integration test cannot reach this code path; only a live
					// HTTP server exercises the auth middleware that's racy.
					const concurrentResponses = await Promise.all(
						Array.from({ length: 14 }, (_, i) =>
							fetch(`${server.baseUrl}/_emdash/api/mcp`, {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Accept: "application/json, text/event-stream",
									Authorization: `Bearer ${token}`,
								},
								body: JSON.stringify([
									{ jsonrpc: "2.0", method: "notifications/initialized" },
									{
										jsonrpc: "2.0",
										method: "tools/list",
										params: {},
										id: 100 + i,
									},
								]),
							}),
						),
					);

					const statusCodes = concurrentResponses.map((r) => r.status);
					const failedStatuses = statusCodes.filter((s) => s !== 200);
					expect(
						failedStatuses,
						`expected all 14 concurrent calls to return 200; got: ${statusCodes.join(",")}`,
					).toEqual([]);
				} catch (error) {
					throw new Error(
						`${site.name} MCP smoke failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
							server.output.slice(-3000),
						{ cause: error },
					);
				} finally {
					await killServer(server.process);
				}
			},
		);
	}

	it(
		"plugin MCP enablement, scoped invocation, and auditing work end to end",
		{ timeout: PLUGIN_MCP_SITE.startupTimeoutMs + 120_000 },
		async () => {
			const server = await bootSite(PLUGIN_MCP_SITE);
			const headers = (token: string) => ({
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
			});
			const listTools = async (token: string) => {
				const response = await fetch(`${server.baseUrl}/_emdash/api/mcp`, {
					method: "POST",
					headers: headers(token),
					body: JSON.stringify([
						{ jsonrpc: "2.0", method: "notifications/initialized" },
						{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
					]),
				});
				expect(response.status).toBe(200);
				return parseSSE(await response.text());
			};
			const callEcho = async (token: string, message: string) => {
				const response = await fetch(`${server.baseUrl}/_emdash/api/mcp`, {
					method: "POST",
					headers: headers(token),
					body: JSON.stringify([
						{ jsonrpc: "2.0", method: "notifications/initialized" },
						{
							jsonrpc: "2.0",
							id: 2,
							method: "tools/call",
							params: { name: "mcp-smoke__echo", arguments: { message } },
						},
					]),
				});
				expect(response.status).toBe(200);
				return parseSSE(await response.text());
			};

			try {
				const setupResponse = await fetchWithRetry(
					`${server.baseUrl}/_emdash/api/setup/dev-bypass?token=1`,
				);
				expect(setupResponse.status).toBe(200);
				const setup = (await setupResponse.json()) as { data?: { token?: string } };
				const adminToken = setup.data?.token;
				expect(adminToken).toBeTruthy();
				if (!adminToken) throw new Error("Dev bypass did not return an admin token");

				const beforeEnable = await listTools(adminToken);
				expect(beforeEnable).not.toHaveProperty(
					"result.tools",
					expect.arrayContaining([expect.objectContaining({ name: "mcp-smoke__echo" })]),
				);

				const enableResponse = await fetch(
					`${server.baseUrl}/_emdash/api/admin/plugins/mcp-smoke/mcp`,
					{
						method: "PUT",
						headers: headers(adminToken),
						body: JSON.stringify({ enabled: true }),
					},
				);
				expect(enableResponse.status).toBe(200);

				const tokenResponse = await fetch(`${server.baseUrl}/_emdash/api/admin/api-tokens`, {
					method: "POST",
					headers: headers(adminToken),
					body: JSON.stringify({ name: "Plugin MCP smoke", scopes: ["mcp:tools:mcp-smoke"] }),
				});
				expect(tokenResponse.status).toBe(201);
				const created = (await tokenResponse.json()) as { data?: { token?: string } };
				const scopedToken = created.data?.token;
				expect(scopedToken).toBeTruthy();
				if (!scopedToken) throw new Error("Token creation did not return a token");

				const listed = await listTools(scopedToken);
				expect(listed).toHaveProperty(
					"result.tools",
					expect.arrayContaining([
						expect.objectContaining({
							name: "mcp-smoke__echo",
							annotations: expect.objectContaining({ destructiveHint: false }),
						}),
					]),
				);

				const denied = await callEcho(adminToken, "blocked");
				expect(denied).toHaveProperty("result.isError", true);
				expect(denied).toHaveProperty("result._meta.code", "INSUFFICIENT_SCOPE");

				const invoked = await callEcho(scopedToken, "hello");
				expect(invoked).not.toHaveProperty("result.isError", true);
				expect(invoked).toHaveProperty("result.structuredContent", {
					message: "hello",
					length: 5,
				});

				const db = new Database(join(PLUGIN_MCP_SITE.dir, "data.db"), { readonly: true });
				try {
					const auditRows = db
						.prepare(
							"SELECT action, resource_type, resource_id, status FROM audit_logs WHERE resource_id = ? ORDER BY timestamp",
						)
						.all("mcp-smoke__echo");
					expect(auditRows).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								action: "plugin_tool_invoke",
								resource_type: "plugin_mcp_tool",
								status: "denied",
							}),
							expect.objectContaining({
								action: "plugin_tool_invoke",
								resource_type: "plugin_mcp_tool",
								status: "success",
							}),
						]),
					);
				} finally {
					db.close();
				}

				const disableResponse = await fetch(
					`${server.baseUrl}/_emdash/api/admin/plugins/mcp-smoke/mcp`,
					{
						method: "PUT",
						headers: headers(adminToken),
						body: JSON.stringify({ enabled: false }),
					},
				);
				expect(disableResponse.status).toBe(200);

				const afterDisable = await listTools(scopedToken);
				expect(afterDisable).not.toHaveProperty(
					"result.tools",
					expect.arrayContaining([expect.objectContaining({ name: "mcp-smoke__echo" })]),
				);
			} catch (error) {
				throw new Error(
					`Plugin MCP smoke failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
						server.output.slice(-3000),
					{ cause: error },
				);
			} finally {
				await killServer(server.process);
			}
		},
	);
});

/**
 * Parse the first JSON-RPC message from an SSE text response.
 * MCP stateless mode returns `event: message\ndata: {...}\n\n`.
 */
function parseSSE(text: string): unknown {
	for (const line of text.split("\n")) {
		if (line.startsWith("data: ")) {
			return JSON.parse(line.slice(6));
		}
	}
	// Fall back to parsing as plain JSON (non-SSE response)
	return JSON.parse(text);
}
