import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
		name: "templates/blank",
		dir: resolve(WORKSPACE_ROOT, "templates/blank"),
		port: 4611,
		startupTimeoutMs: 60_000,
	},
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
// and the playground demo in parallel.
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
// Runtime verification — boots each site with `astro dev` and checks that
// admin + frontend respond.
// ---------------------------------------------------------------------------

describe.sequential("Site runtime verification", () => {
	for (const site of SITE_MATRIX) {
		const waitPath = site.waitPath ?? "/_emdash/admin/";
		const setupPath = site.setupPath ?? "/_emdash/api/setup/dev-bypass?redirect=/";
		const frontendPath = site.frontendPath ?? "/";
		const frontendStatuses = site.frontendStatuses ?? [200, 302, 307, 308];
		const requireDoctype = site.requireDoctype ?? true;

		it(
			`${site.name} boots and serves admin + frontend`,
			{ timeout: site.startupTimeoutMs + 120_000 },
			async () => {
				await ensureBuilt();

				// Remove stale database files so each run starts fresh.
				// SQLite demos use data.db; WAL/SHM sidecars may also exist.
				for (const file of ["data.db", "data.db-wal", "data.db-shm"]) {
					rmSync(join(site.dir, file), { force: true });
				}

				const baseUrl = `http://localhost:${site.port}`;
				const serverProcess = spawn("pnpm", ["exec", "astro", "dev", "--port", String(site.port)], {
					cwd: site.dir,
					env: {
						...process.env,
						CI: "true",
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

				try {
					await waitForServer(`${baseUrl}${waitPath}`, site.startupTimeoutMs);

					if (setupPath) {
						const setupRes = await fetchWithRetry(`${baseUrl}${setupPath}`);
						expect(setupRes.status).toBeLessThan(500);
					}

					const adminRes = await fetchWithRetry(`${baseUrl}/_emdash/admin/`);
					expect(adminRes.status).toBeLessThan(500);

					const frontendRes = await fetchWithRetry(`${baseUrl}${frontendPath}`);
					expect(frontendStatuses).toContain(frontendRes.status);

					const body = await frontendRes.text();
					if (requireDoctype) {
						expect(body).toContain("<!DOCTYPE html>");
					}
				} catch (error) {
					throw new Error(
						`${site.name} smoke failed: ${error instanceof Error ? error.message : String(error)}\n\n` +
							output.slice(-3000),
						{ cause: error },
					);
				} finally {
					serverProcess.kill("SIGTERM");
					await new Promise((resolveSleep) => setTimeout(resolveSleep, 1200));
					if (!serverProcess.killed) {
						serverProcess.kill("SIGKILL");
						await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
					}
				}
			},
		);
	}
});
