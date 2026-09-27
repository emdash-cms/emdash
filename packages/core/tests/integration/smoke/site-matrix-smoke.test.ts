import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { consumerEnvironment } from "../../utils/consumer-environment.js";
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
	verifyMcp?: boolean;
	frontendExpectations?: Array<{ path: string; text: string }>;
}

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const execAsync = promisify(execFile);
const SETUP_REQUEST_TIMEOUT_MS = 30_000;
const SMOKE_FONT_PROVIDER_IMPORT = pathToFileURL(
	resolve(import.meta.dirname, "smoke-font-provider.mjs"),
).href;

function nodeOptionsWithSmokeFontProvider(): string {
	return [process.env.NODE_OPTIONS, `--import=${SMOKE_FONT_PROVIDER_IMPORT}`]
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
		verifyMcp: true,
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
		frontendExpectations: [
			{ path: "/", text: "Build products people actually want" },
			{ path: "/pricing", text: "Simple, transparent pricing" },
		],
	},
	{
		name: "templates/marketing-cloudflare",
		dir: resolve(WORKSPACE_ROOT, "templates/marketing-cloudflare"),
		port: 4615,
		startupTimeoutMs: 120_000,
		frontendExpectations: [
			{ path: "/", text: "Build products people actually want" },
			{ path: "/pricing", text: "Simple, transparent pricing" },
		],
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
		verifyMcp: true,
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

function fetchSetupOnce(url: string): Promise<Response> {
	return fetch(url, {
		redirect: "manual",
		signal: AbortSignal.timeout(SETUP_REQUEST_TIMEOUT_MS),
	});
}

// ---------------------------------------------------------------------------
// Build verification — runs a single recursive `pnpm build` across templates
// and the playground demo in parallel. The child process replaces Astro's
// Google provider with a local font so the smoke suite exercises the font
// pipeline without depending on Google's CSS and asset rollouts being in sync.
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
					env: consumerEnvironment({
						CI: "true",
						NODE_OPTIONS: nodeOptionsWithSmokeFontProvider(),
					}),
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
	const astroBin = join(site.dir, "node_modules", ".bin", "astro");
	const serverProcess = spawn(astroBin, ["dev", "--port", String(site.port)], {
		cwd: site.dir,
		env: consumerEnvironment({
			ASTRO_DEV_BACKGROUND: "1",
			CI: "true",
			NODE_OPTIONS: nodeOptionsWithSmokeFontProvider(),
		}),
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

async function killServer(serverProcess: ReturnType<typeof spawn>): Promise<void> {
	if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
	const exited = once(serverProcess, "exit");
	if (!serverProcess.kill("SIGTERM")) return;
	const stopped = await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })]);
	if (stopped) return;
	serverProcess.kill("SIGKILL");
	await Promise.race([exited, delay(1000, undefined, { ref: false })]);
}

async function verifyCoreMcp(baseUrl: string, token: string): Promise<void> {
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${token}`,
	};
	const initRes = await fetch(`${baseUrl}/_emdash/api/mcp`, {
		method: "POST",
		headers,
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
	expect(parseSSE(await initRes.text())).toHaveProperty("result.serverInfo.name", "emdash");

	const listBody = (id: number) =>
		JSON.stringify([
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", method: "tools/list", params: {}, id },
		]);
	const listRes = await fetch(`${baseUrl}/_emdash/api/mcp`, {
		method: "POST",
		headers,
		body: listBody(2),
	});
	expect(listRes.status).toBe(200);
	const listData = parseSSE(await listRes.text());
	expect(listData).toHaveProperty("result.tools");
	const tools = (listData as { result: { tools: Array<{ name: string }> } }).result.tools;
	expect(tools.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["content_list", "schema_list_collections"]),
	);

	const concurrentResponses = await Promise.all(
		Array.from({ length: 14 }, (_, index) =>
			fetch(`${baseUrl}/_emdash/api/mcp`, {
				method: "POST",
				headers,
				body: listBody(100 + index),
			}),
		),
	);
	expect(concurrentResponses.map((response) => response.status)).toEqual(
		Array.from({ length: 14 }).fill(200),
	);
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
			`${site.name} boots and serves admin + frontend${site.verifyMcp ? " + MCP" : ""}`,
			{ timeout: site.startupTimeoutMs + 120_000 },
			async () => {
				const server = await bootSite(site);

				try {
					let mcpToken: string | undefined;
					if (setupPath) {
						const setupRes = await fetchSetupOnce(
							`${server.baseUrl}${site.verifyMcp ? "/_emdash/api/setup/dev-bypass?token=1" : setupPath}`,
						);
						expect(setupRes.status).toBeLessThan(500);
						if (site.verifyMcp) {
							const setup = (await setupRes.json()) as { data?: { token?: string } };
							mcpToken = setup.data?.token;
							expect(mcpToken).toBeTruthy();
						}
					}

					const adminRes = await fetchWithRetry(`${server.baseUrl}/_emdash/admin/`);
					expect(adminRes.status).toBeLessThan(500);

					const frontendRes = await fetchWithRetry(`${server.baseUrl}${frontendPath}`);
					expect(frontendStatuses).toContain(frontendRes.status);

					const body = await frontendRes.text();
					if (requireDoctype) {
						expect(body).toContain("<!DOCTYPE html>");
					}
					for (const expectation of site.frontendExpectations ?? []) {
						const response = await fetchWithRetry(`${server.baseUrl}${expectation.path}`);
						expect(response.status).toBe(200);
						expect(await response.text()).toContain(expectation.text);
					}
					if (site.verifyMcp && mcpToken) {
						await verifyCoreMcp(server.baseUrl, mcpToken);
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

const CLOUDFLARE_OPTIMIZER_SITE: SiteCase = {
	name: "e2e/fixture-cloudflare",
	dir: resolve(WORKSPACE_ROOT, "e2e/fixture-cloudflare"),
	port: 4621,
	startupTimeoutMs: 120_000,
	waitPath: "/_emdash/api/setup/status",
};

const LATE_MANIFEST_OPTIMIZATION =
	/(?:new )?dependenc(?:y|ies) (?:found|optimized):.*astro\/app\/manifest/;

describe.sequential("Cloudflare dependency optimizer", () => {
	it(
		"pre-bundles dependencies imported by transformed server modules",
		{ timeout: CLOUDFLARE_OPTIMIZER_SITE.startupTimeoutMs + 120_000 },
		async () => {
			rmSync(join(CLOUDFLARE_OPTIMIZER_SITE.dir, "node_modules/.vite"), {
				recursive: true,
				force: true,
			});
			const devLogPath = join(CLOUDFLARE_OPTIMIZER_SITE.dir, ".astro/dev.log");
			rmSync(devLogPath, { force: true });
			const server = await bootSite(CLOUDFLARE_OPTIMIZER_SITE);

			try {
				const frontendRes = await fetchWithRetry(`${server.baseUrl}/`);
				expect([200, 302, 307, 308]).toContain(frontendRes.status);
				await frontendRes.text();
				const readOptimizerOutput = () =>
					[server.output, existsSync(devLogPath) ? readFileSync(devLogPath, "utf8") : ""].join(
						"\n",
					);
				const observationDeadline = Date.now() + 5_000;
				while (Date.now() < observationDeadline) {
					expect(readOptimizerOutput()).not.toMatch(LATE_MANIFEST_OPTIMIZATION);
					await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
				}
				expect(readOptimizerOutput()).not.toMatch(LATE_MANIFEST_OPTIMIZATION);
			} finally {
				await killServer(server.process);
				await execAsync("pnpm", ["exec", "astro", "dev", "stop"], {
					cwd: CLOUDFLARE_OPTIMIZER_SITE.dir,
				});
			}
		},
	);
});

// ---------------------------------------------------------------------------
// MCP endpoint verification for plugin-provided tools.
// ---------------------------------------------------------------------------

const PLUGIN_MCP_SITE: SiteCase = {
	name: "demos/simple",
	dir: resolve(WORKSPACE_ROOT, "demos/simple"),
	port: 4620,
	startupTimeoutMs: 90_000,
};

describe.sequential("MCP endpoint verification", () => {
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
				const setupResponse = await fetchSetupOnce(
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
