/**
 * Integration test server helper.
 *
 * Bootstraps an isolated Astro dev server from a minimal fixture,
 * runs setup, seeds test data, and creates auth tokens. Each test
 * suite gets a fresh database and server process.
 *
 * Usage:
 *
 *   const ctx = await createTestServer({ port: 4399 });
 *   // ctx.client  — EmDashClient (devBypass auth)
 *   // ctx.token   — PAT bearer token for CLI tests
 *   // ctx.baseUrl — http://localhost:4399
 *   // ctx.cwd     — working directory of the running server
 *   await ctx.cleanup();
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { EmDashClient } from "../../src/client/index.js";

const execAsync = promisify(execFile);

// Test regex patterns
const SESSION_COOKIE_REGEX = /^([^;]+)/;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(import.meta.dirname, "fixture");
// Borrow node_modules from demos/simple — it has all the deps we need
// and is maintained by pnpm workspace resolution.
const DONOR_NODE_MODULES = resolve(import.meta.dirname, "../../../../demos/simple/node_modules");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestServerOptions {
	port: number;
	/** Server startup timeout in ms (default: 90_000) */
	timeout?: number;
	/** Seed test data after setup (default: true) */
	seed?: boolean;
	/** Additional environment variables to pass to the dev server */
	env?: Record<string, string>;
}

export interface TestServerContext {
	/** Base URL of the running server */
	baseUrl: string;
	/** Working directory containing the fixture */
	cwd: string;
	/** EmDashClient authenticated via dev-bypass session */
	client: EmDashClient;
	/** PAT bearer token with full scopes (for CLI / raw fetch tests) */
	token: string;
	/** Seeded collection slugs */
	collections: string[];
	/** Seeded content IDs keyed by collection */
	contentIds: Record<string, string[]>;
	/** Session cookie string for raw fetch calls needing session auth */
	sessionCookie: string;
	/** Stop the server and remove the temp directory */
	cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Node.js version guard
// ---------------------------------------------------------------------------

/**
 * Astro requires Node.js >= 22.12.0. Call from a `beforeAll` to fail the
 * suite immediately when the environment is misconfigured rather than
 * silently skipping.
 */
export function assertNodeVersion(): void {
	const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
	const ok = major! > 22 || (major === 22 && minor! >= 12);
	if (!ok) {
		throw new Error(
			`Integration tests require Node.js >= 22.12.0 (running ${process.versions.node}). ` +
				`Update your Node version instead of skipping tests.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Build guard
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");
const CLI_BINARY = resolve(import.meta.dirname, "../../dist/cli/index.mjs");

let buildPromise: Promise<void> | null = null;

/**
 * Ensure the workspace is built before starting integration tests.
 * Runs `pnpm build` once (cached across test suites via module-level promise).
 * Skips if the CLI binary already exists.
 */
export function ensureBuilt(): Promise<void> {
	if (!buildPromise) {
		buildPromise = doBuild();
	}
	return buildPromise;
}

async function doBuild(): Promise<void> {
	if (existsSync(CLI_BINARY)) return;

	console.log("[integration] Built artifacts missing — running pnpm build...");
	await execAsync("pnpm", ["build"], {
		cwd: WORKSPACE_ROOT,
		timeout: 120_000,
	});
	console.log("[integration] Build complete.");
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
			// Any HTTP response (even 500) means the server is up.
			// We only keep waiting on connection errors (caught below).
			if (res.status > 0) return;
		} catch {
			// Server not ready yet — connection refused / timeout
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/**
 * Create an Astro dev server for integration testing.
 *
 * Runs the fixture in-place to avoid Astro virtual module resolution
 * issues with symlinked temp dirs. Uses a temp directory only for the
 * database file — source files stay at their real paths.
 */
export async function createTestServer(options: TestServerOptions): Promise<TestServerContext> {
	const { port, timeout = 90_000, seed = true } = options;
	const baseUrl = `http://localhost:${port}`;

	// --- 0. Ensure workspace is built ---
	await ensureBuilt();

	// --- 1. Run fixture in-place, temp dir only for DB ---
	const workDir = FIXTURE_DIR;
	const tempDataDir = mkdtempSync(join(tmpdir(), "emdash-integration-"));
	const dbPath = join(tempDataDir, "test.db");
	const uploadsDir = join(tempDataDir, "uploads");
	mkdirSync(uploadsDir, { recursive: true });

	// Ensure node_modules symlink exists in the fixture dir.
	// Multiple test suites may race to create this — handle EEXIST gracefully.
	// The symlink is intentionally never removed: it's shared across concurrent
	// test suites and gitignored, so cleanup of one suite must not break others.
	const fixtureNodeModules = join(FIXTURE_DIR, "node_modules");
	if (!existsSync(fixtureNodeModules)) {
		try {
			symlinkSync(DONOR_NODE_MODULES, fixtureNodeModules);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
	}

	// --- 2. Start dev server ---
	const astroBin = join(fixtureNodeModules, ".bin", "astro");
	const server = spawn(astroBin, ["dev", "--port", String(port)], {
		cwd: workDir,
		env: {
			...process.env,
			EMDASH_TEST_DB: `file:${dbPath}`,
			EMDASH_TEST_UPLOADS: uploadsDir,
			...options.env,
		},
		stdio: "pipe",
	});

	// Always capture server output. Forward to stderr when DEBUG is set,
	// and always keep a ring buffer of the last 5 KB for error reporting.
	let serverOutput = "";
	const MAX_OUTPUT = 5000;
	function appendOutput(chunk: string): void {
		if (process.env.DEBUG) process.stderr.write(`[integration:${port}] ${chunk}`);
		serverOutput += chunk;
		if (serverOutput.length > MAX_OUTPUT * 2) {
			serverOutput = serverOutput.slice(-MAX_OUTPUT);
		}
	}
	server.stdout?.on("data", (data: Buffer) => appendOutput(data.toString()));
	server.stderr?.on("data", (data: Buffer) => appendOutput(data.toString()));

	// Track for cleanup
	let stopped = false;

	async function cleanup(): Promise<void> {
		if (stopped) return;
		stopped = true;

		server.kill("SIGTERM");
		await new Promise((r) => setTimeout(r, 1000));

		// Force kill if still alive
		if (!server.killed) {
			server.kill("SIGKILL");
			await new Promise((r) => setTimeout(r, 500));
		}

		// Remove temp data directory
		rmSync(tempDataDir, { recursive: true, force: true });
	}

	try {
		// --- 3. Wait for server to be ready ---
		await waitForServer(`${baseUrl}/_emdash/api/setup/dev-bypass`, timeout);

		// --- 4. Run setup + create PAT in one request ---
		// The ?token query param tells the dev-bypass endpoint to also
		// create a PAT with full scopes and return it in the response.
		const setupRes = await fetch(`${baseUrl}/_emdash/api/setup/dev-bypass?token=1`);
		if (!setupRes.ok) {
			const body = await setupRes.text().catch(() => "");
			throw new Error(`Setup bypass failed (${setupRes.status}): ${body}`);
		}
		const setupJson = (await setupRes.json()) as {
			data: { user: { id: string; email: string }; token?: string };
		};
		const setupData = setupJson.data;
		const token = setupData.token;
		if (!token) {
			throw new Error("Setup bypass did not return a PAT token");
		}

		// Extract session cookie for raw fetch calls that need session auth
		const setCookie = setupRes.headers.get("set-cookie");
		let sessionCookie = "";
		if (setCookie) {
			const match = setCookie.match(SESSION_COOKIE_REGEX);
			if (match) sessionCookie = match[1]!;
		}

		// --- 5. Create client authenticated via PAT ---
		const client = new EmDashClient({
			baseUrl,
			token,
		});

		// --- 8. Seed test data ---
		const collections: string[] = [];
		const contentIds: Record<string, string[]> = {};

		if (seed) {
			await seedTestData(client, collections, contentIds);
		}

		return {
			baseUrl,
			cwd: workDir,
			client,
			token,
			collections,
			contentIds,
			sessionCookie,
			cleanup,
		};
	} catch (error) {
		// Include server output in error for CI debugging
		const msg = error instanceof Error ? error.message : String(error);
		await cleanup();
		throw new Error(
			`${msg}\n\nServer output (last ${MAX_OUTPUT} chars):\n${serverOutput.slice(-MAX_OUTPUT)}`,
			{
				cause: error,
			},
		);
	}
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

/**
 * Seeds sample content into the test server.
 *
 * Collections and fields are created by the seed file
 * (fixture/.emdash/seed.json) during dev-bypass setup.
 * This function only creates content entries.
 *
 * Content:
 *   - posts: 3 items (2 published, 1 draft)
 *   - pages: 2 items (1 published, 1 draft)
 */
async function seedTestData(
	client: EmDashClient,
	collections: string[],
	contentIds: Record<string, string[]>,
): Promise<void> {
	collections.push("posts");
	collections.push("pages");

	const postIds: string[] = [];

	const post1 = await client.create("posts", {
		data: {
			title: "First Post",
			body: "Hello **world**. This is the first post.",
			excerpt: "The very first post",
		},
		slug: "first-post",
	});
	postIds.push(post1.id);
	await client.publish("posts", post1.id);

	const post2 = await client.create("posts", {
		data: {
			title: "Second Post",
			body: "A second post with a [link](https://example.com).",
			excerpt: "Another post",
		},
		slug: "second-post",
	});
	postIds.push(post2.id);
	await client.publish("posts", post2.id);

	const post3 = await client.create("posts", {
		data: {
			title: "Draft Post",
			body: "This post is still a draft.",
			excerpt: "Not published yet",
		},
		slug: "draft-post",
	});
	postIds.push(post3.id);

	contentIds["posts"] = postIds;

	const pageIds: string[] = [];

	const page1 = await client.create("pages", {
		data: {
			title: "About",
			body: "# About Us\n\nWe are a **test** fixture.",
		},
		slug: "about",
	});
	pageIds.push(page1.id);
	await client.publish("pages", page1.id);

	const page2 = await client.create("pages", {
		data: {
			title: "Contact",
			body: "Get in touch.",
		},
		slug: "contact",
	});
	pageIds.push(page2.id);

	contentIds["pages"] = pageIds;
}
