/**
 * Playwright global setup.
 *
 * Starts an isolated Astro dev server from the minimal e2e fixture,
 * runs dev-bypass setup, and seeds test data. Writes server info
 * to a temp file so tests and teardown can find it.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

interface Target {
	fixtureDir: string;
	buildFilter: string;
	depsMarker: string;
	usesTempDb: boolean;
}

const TARGETS: Record<string, Target> = {
	node: {
		fixtureDir: resolve(ROOT, "e2e/fixture"),
		buildFilter: "emdash-e2e-fixture...",
		depsMarker: resolve(ROOT, "packages/plugins/color/dist/index.mjs"),
		usesTempDb: true,
	},
	cloudflare: {
		fixtureDir: resolve(ROOT, "e2e/fixture-cloudflare"),
		buildFilter: "emdash-e2e-fixture-cloudflare...",
		depsMarker: resolve(ROOT, "packages/cloudflare/dist/index.mjs"),
		usesTempDb: false,
	},
};

const TARGET = TARGETS[process.env.EMDASH_E2E_TARGET ?? "node"] ?? TARGETS.node!;
const FIXTURE_DIR = TARGET.fixtureDir;
const CLI_BINARY = resolve(ROOT, "packages/core/dist/cli/index.mjs");
const PORT = 4444;
const MARKETPLACE_PORT = 4445;
const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");

// Regex patterns
const COOKIE_VALUE_PATTERN = /^([^;]+)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureBuilt(): Promise<void> {
	if (existsSync(CLI_BINARY)) return;
	console.log("[pw] Built artifacts missing — running pnpm build...");
	await execAsync("pnpm", ["build"], { cwd: ROOT, timeout: 120_000 });
	console.log("[pw] Build complete.");
}

/**
 * Ensure all e2e fixture dependencies are built.
 * The CI build filter (--filter emdash...) only builds emdash and its deps,
 * not the fixture's plugin dependencies like @emdash-cms/plugin-color.
 */
async function ensureFixtureDepsBuilt(): Promise<void> {
	if (existsSync(TARGET.depsMarker)) return;
	console.log("[pw] Building e2e fixture dependencies...");
	await execAsync("pnpm", ["run", "--filter", TARGET.buildFilter, "build"], {
		cwd: ROOT,
		timeout: 180_000,
	});
	console.log("[pw] Fixture deps built.");
}

/**
 * Poll an endpoint until it returns a 2xx. We gate on a real success rather
 * than "server responding" because the dev server's Vite dep optimizer 500s on
 * cold start until it finishes pre-bundling -- pronounced under the Cloudflare
 * (workerd) runner, where the first requests fail with optimize-deps errors.
 */
async function waitForOk(url: string, timeoutMs: number): Promise<Response> {
	const start = Date.now();
	let lastStatus = 0;
	let lastBody = "";
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			if (res.ok) return res;
			lastStatus = res.status;
			lastBody = await res.text().catch(() => "");
		} catch {
			// Server/optimizer not ready yet
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`${url} did not return ok within ${timeoutMs}ms (last ${lastStatus}): ${lastBody.slice(0, 300)}`,
	);
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

async function apiPost(baseUrl: string, token: string, path: string, body: unknown): Promise<any> {
	const res = await fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			"X-EmDash-Request": "1",
			Origin: baseUrl,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`POST ${path} failed (${res.status}): ${text}`);
	}
	const json: any = await res.json();
	return json.data ?? json;
}

async function apiUploadMedia(
	baseUrl: string,
	token: string,
	filePath: string,
	filename: string,
	mimeType: string,
): Promise<{ id: string; storageKey: string; url: string }> {
	const fileBuffer = readFileSync(filePath);
	const blob = new Blob([fileBuffer], { type: mimeType });
	const formData = new FormData();
	formData.append("file", blob, filename);
	formData.append("width", "1");
	formData.append("height", "1");

	const res = await fetch(`${baseUrl}/_emdash/api/media`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-EmDash-Request": "1",
			Origin: baseUrl,
		},
		body: formData,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Media upload failed (${res.status}): ${text}`);
	}
	const json: any = await res.json();
	const item = (json.data ?? json).item;
	return { id: item.id, storageKey: item.storageKey, url: item.url };
}

async function seedTestData(
	baseUrl: string,
	token: string,
): Promise<{
	collections: string[];
	contentIds: Record<string, string[]>;
	mediaIds: Record<string, string>;
}> {
	const collections: string[] = ["posts", "pages"];
	const contentIds: Record<string, string[]> = {};
	const mediaIds: Record<string, string> = {};

	// Collections and fields are created by the fixture seed file
	// (fixture/.emdash/seed.json) during dev-bypass setup.

	const postIds: string[] = [];
	let result: any;

	result = await apiPost(baseUrl, token, "/_emdash/api/content/posts", {
		data: { title: "First Post", excerpt: "The very first post" },
		slug: "first-post",
	});
	postIds.push(result.item?.id ?? result.id);
	await apiPost(baseUrl, token, `/_emdash/api/content/posts/${postIds[0]}/publish`, {});

	result = await apiPost(baseUrl, token, "/_emdash/api/content/posts", {
		data: { title: "Second Post", excerpt: "Another post" },
		slug: "second-post",
	});
	postIds.push(result.item?.id ?? result.id);
	await apiPost(baseUrl, token, `/_emdash/api/content/posts/${postIds[1]}/publish`, {});

	result = await apiPost(baseUrl, token, "/_emdash/api/content/posts", {
		data: { title: "Draft Post", excerpt: "Not published yet" },
		slug: "draft-post",
	});
	postIds.push(result.item?.id ?? result.id);

	// --- Upload test image and create post with image block ---
	const testImagePath = join(ROOT, "e2e/fixtures/assets/test-image.png");
	const media = await apiUploadMedia(baseUrl, token, testImagePath, "test-image.png", "image/png");
	mediaIds["testImage"] = media.id;

	result = await apiPost(baseUrl, token, "/_emdash/api/content/posts", {
		data: {
			title: "Post With Image",
			excerpt: "A post containing an image block",
			body: [
				{
					_type: "block",
					_key: "b1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "Text before image." }],
					markDefs: [],
				},
				{
					_type: "image",
					_key: "img1",
					asset: { _ref: media.id, url: media.url },
					alt: "Test image",
					width: 1,
					height: 1,
				},
				{
					_type: "block",
					_key: "b2",
					style: "normal",
					children: [{ _type: "span", _key: "s2", text: "Text after image." }],
					markDefs: [],
				},
			],
		},
		slug: "post-with-image",
	});
	postIds.push(result.item?.id ?? result.id);
	await apiPost(baseUrl, token, `/_emdash/api/content/posts/${postIds[3]}/publish`, {});

	contentIds["posts"] = postIds;

	const pageIds: string[] = [];

	result = await apiPost(baseUrl, token, "/_emdash/api/content/pages", {
		data: { title: "About" },
		slug: "about",
	});
	pageIds.push(result.item?.id ?? result.id);
	await apiPost(baseUrl, token, `/_emdash/api/content/pages/${pageIds[0]}/publish`, {});

	result = await apiPost(baseUrl, token, "/_emdash/api/content/pages", {
		data: { title: "Contact" },
		slug: "contact",
	});
	pageIds.push(result.item?.id ?? result.id);
	contentIds["pages"] = pageIds;

	return { collections, contentIds, mediaIds };
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<void> {
	await ensureBuilt();
	await ensureFixtureDepsBuilt();

	// 0. Start mock marketplace server
	const { startMockMarketplace } = await import("./fixtures/mock-marketplace.js");
	const marketplaceServer = await startMockMarketplace(MARKETPLACE_PORT);
	const marketplaceUrl = `http://127.0.0.1:${MARKETPLACE_PORT}`;
	console.log(`[pw] Mock marketplace ready at ${marketplaceUrl}`);

	// 1. Run the fixture in-place to avoid Astro beta CSS virtual module
	// resolution bugs with symlinked temp dirs. Use a temp directory only for
	// the database — source files stay at their real paths so Astro's virtual
	// module resolver can find the compile metadata.
	const workDir = FIXTURE_DIR;
	const tempDataDir = mkdtempSync(join(tmpdir(), "emdash-pw-"));
	const dbPath = join(tempDataDir, "test.db");

	const fixtureNodeModules = join(FIXTURE_DIR, "node_modules");

	const baseUrl = `http://localhost:${PORT}`;

	// Cloudflare target: start from fresh miniflare D1/R2 state each run so the
	// fixture's seed isn't duplicated across runs (the Node target gets this for
	// free via its per-run temp database).
	if (!TARGET.usesTempDb) {
		rmSync(join(FIXTURE_DIR, ".wrangler"), { recursive: true, force: true });
	}

	// 2. Start dev server (with marketplace URL injected via env)
	const astroBin = join(fixtureNodeModules, ".bin", "astro");
	const server = spawn(astroBin, ["dev", "--port", String(PORT)], {
		cwd: workDir,
		env: {
			...process.env,
			EMDASH_TEST_DB: `file:${dbPath}`,
			EMDASH_MARKETPLACE_URL: marketplaceUrl,
		},
		stdio: "pipe",
	});

	server.stdout?.on("data", (data: Buffer) => {
		if (process.env.DEBUG) process.stderr.write(`[pw:${PORT}] ${data.toString()}`);
	});
	server.stderr?.on("data", (data: Buffer) => {
		if (process.env.DEBUG) process.stderr.write(`[pw:${PORT}] ${data.toString()}`);
	});

	try {
		// 3 + 4. Wait for the server and dev optimizer to settle, then run setup
		// + create a PAT. The gate polls until dev-bypass actually returns 200,
		// absorbing the optimizer's cold-start failures.
		console.log("[pw] Waiting for server + setup...");
		const setupRes = await waitForOk(`${baseUrl}/_emdash/api/setup/dev-bypass?token=1`, 120_000);
		const setupJson: { data: { user: { id: string }; token?: string } } = await setupRes.json();
		const setupData = setupJson.data;
		const token = setupData.token;
		if (!token) throw new Error("Setup bypass did not return a PAT token");

		const setCookie = setupRes.headers.get("set-cookie");
		let sessionCookie = "";
		if (setCookie) {
			const match = setCookie.match(COOKIE_VALUE_PATTERN);
			if (match) sessionCookie = match[1]!;
		}

		// 5. Seed test data
		console.log("[pw] Seeding test data...");
		const seed = await seedTestData(baseUrl, token);

		// 5b. Warm up pages that use emdash/ui (triggers Astro compilation of all
		// component virtual modules, avoiding race conditions in tests)
		console.log("[pw] Warming up pages...");
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const resp = await fetch(`${baseUrl}/posts/post-with-image`);
				if (resp.ok) break;
				// Retry on compilation errors — Astro may need multiple passes
				await new Promise((r) => setTimeout(r, 1000));
			} catch {
				await new Promise((r) => setTimeout(r, 1000));
			}
		}

		// 6. Write server info
		const info = {
			pid: server.pid!,
			workDir,
			tempDataDir,
			baseUrl,
			marketplaceUrl,
			token,
			sessionCookie,
			collections: seed.collections,
			contentIds: seed.contentIds,
			mediaIds: seed.mediaIds,
		};
		writeFileSync(SERVER_INFO_PATH, JSON.stringify(info, null, 2));

		console.log(`[pw] Server ready at ${baseUrl} (pid ${server.pid})`);
	} catch (error) {
		server.kill("SIGTERM");
		marketplaceServer.close();
		throw error;
	}
}
