import { execFile, spawn } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, test, type BrowserContext } from "@playwright/test";

import { consumerEnvironment } from "../../packages/core/tests/utils/consumer-environment.js";

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = join(WORKSPACE_ROOT, "packages/core/tests/integration/fixture");
const SERVERS_BASE = join(WORKSPACE_ROOT, "packages/core/tests/integration/.servers");
const DONOR_NODE_MODULES = resolve(WORKSPACE_ROOT, "demos/simple/node_modules");
const CLI_BIN = join(WORKSPACE_ROOT, "packages/core/dist/cli/index.mjs");
const MARKER = "--emdash-plugin-admin-css-test";
const SMOKE_FONT_PROVIDER_IMPORT = pathToFileURL(
	join(WORKSPACE_ROOT, "packages/core/tests/integration/smoke/smoke-font-provider.mjs"),
).href;

function nodeOptionsWithSmokeFontProvider(): string {
	return [process.env.NODE_OPTIONS, `--import=${SMOKE_FONT_PROVIDER_IMPORT}`]
		.filter(Boolean)
		.join(" ");
}

async function getFreePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	return port;
}

async function stop(process: ReturnType<typeof spawn>): Promise<void> {
	if (process.exitCode !== null || process.signalCode !== null) return;
	const exited = new Promise<void>((resolvePromise) => {
		process.once("exit", () => resolvePromise());
		process.once("error", () => resolvePromise());
	});
	try {
		process.kill("SIGTERM");
	} catch {
		return;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			exited,
			new Promise<void>((resolvePromise) => {
				timeout = setTimeout(resolvePromise, 5_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
	if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
}

async function waitFor(url: string): Promise<void> {
	await expect
		.poll(
			async () => {
				try {
					return (await fetch(url)).status;
				} catch {
					return 0;
				}
			},
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(0);
}

test.describe("plugin admin CSS", () => {
	test.skip(process.env.EMDASH_E2E_TARGET === "cloudflare", "This suite builds the Node fixture.");
	let workDir: string | undefined;
	let server: ReturnType<typeof spawn> | undefined;
	let context: BrowserContext | undefined;

	test.afterEach(async () => {
		if (context) {
			await context.close();
			context = undefined;
		}
		if (server) {
			await stop(server);
			server = undefined;
		}
		if (workDir) {
			rmSync(workDir, { recursive: true, force: true });
			workDir = undefined;
		}
	});

	for (const inlineStylesheets of ["auto", "never", "always", "dev"] as const) {
		test(`does not load adminEntry CSS on public pages in ${inlineStylesheets === "dev" ? "development" : `production with inlineStylesheets ${inlineStylesheets}`}`, async ({
			browser,
		}) => {
			test.setTimeout(120_000);
			mkdirSync(SERVERS_BASE, { recursive: true });
			workDir = mkdtempSync(join(SERVERS_BASE, "plugin-admin-css-"));
			cpSync(FIXTURE_DIR, workDir, {
				recursive: true,
				filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
			});
			symlinkSync(DONOR_NODE_MODULES, join(workDir, "node_modules"));

			const configPath = join(workDir, "astro.config.mjs");
			const config = readFileSync(configPath, "utf8").replace(
				"plugins: [colorPlugin()],",
				"plugins: [{ ...colorPlugin(), adminEntry: new URL('./plugin-admin.ts', import.meta.url).pathname }],",
			);
			writeFileSync(
				configPath,
				config.replace(
					"export default defineConfig({",
					`export default defineConfig({\n\t${inlineStylesheets === "dev" ? "build: { inlineStylesheets: 'auto' }," : `build: { inlineStylesheets: '${inlineStylesheets}' },`}`,
				),
			);
			writeFileSync(
				join(workDir, "plugin-admin.ts"),
				"import './plugin-admin.css';\nexport * from '@emdash-cms/plugin-color/admin';\n",
			);
			writeFileSync(join(workDir, "plugin-admin.css"), `:root { ${MARKER}: loaded; }\n`);
			for (const name of ["index", "prerender-check"]) {
				const pagePath = join(workDir, "src/pages", `${name}.astro`);
				writeFileSync(
					pagePath,
					readFileSync(pagePath, "utf8").replace(
						"<html>",
						"<html><head><title>CSS isolation</title></head>",
					),
				);
			}
			writeFileSync(
				join(workDir, "src/pages/404.astro"),
				"---\nexport const prerender = false;\n---\n<html><head><title>Not found</title></head><body>Not found</body></html>\n",
			);

			const databasePath = join(workDir, "prerender.db");
			await execAsync(process.execPath, [
				CLI_BIN,
				"init",
				"--database",
				databasePath,
				"--cwd",
				workDir,
			]);
			await execAsync(process.execPath, [
				CLI_BIN,
				"seed",
				"--database",
				databasePath,
				"--cwd",
				workDir,
			]);
			const astro = join(workDir, "node_modules", ".bin", "astro");
			const port = await getFreePort();
			const environment = consumerEnvironment({
				CI: "true",
				NODE_OPTIONS: nodeOptionsWithSmokeFontProvider(),
				EMDASH_TEST_DB: `file:${databasePath}`,
				EMDASH_TEST_UPLOADS: join(workDir, "uploads"),
				EMDASH_TEST_VITE_CACHE: join(workDir, ".vite-cache"),
				HOST: "127.0.0.1",
				PORT: String(port),
				...(inlineStylesheets === "dev" ? { ASTRO_DEV_BACKGROUND: "1" } : {}),
			});
			if (inlineStylesheets === "dev") {
				server = spawn(astro, ["dev", "--host", "127.0.0.1", "--port", String(port)], {
					cwd: workDir,
					env: environment,
					stdio: "pipe",
				});
			} else {
				await execAsync(astro, ["build"], {
					cwd: workDir,
					timeout: 90_000,
					env: environment,
				});
				server = spawn(process.execPath, [join(workDir, "dist/server/entry.mjs")], {
					cwd: workDir,
					env: { ...environment, HOST: "127.0.0.1", PORT: String(port) },
					stdio: "pipe",
				});
			}
			const baseUrl = `http://127.0.0.1:${port}`;
			await waitFor(`${baseUrl}/`);

			context = await browser.newContext();
			const page = await context.newPage();
			for (const path of ["/", "/prerender-check/", "/404"]) {
				const response = await page.goto(`${baseUrl}${path}`);
				const html = await response!.text();
				if (path === "/404") {
					expect([200, 404]).toContain(response?.status());
				} else {
					expect(response?.status()).toBe(200);
				}
				expect(html).not.toContain(MARKER);
				expect(
					await page.evaluate(
						(marker) => getComputedStyle(document.documentElement).getPropertyValue(marker),
						MARKER,
					),
				).toBe("");
			}

			await page.goto(
				`${baseUrl}${inlineStylesheets === "dev" ? "/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin" : "/_emdash/admin/login"}`,
			);
			await expect(page.locator("h1")).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(
					async () => ({
						marker: await page.evaluate(
							(marker) => getComputedStyle(document.documentElement).getPropertyValue(marker),
							MARKER,
						),
						bootLoaderCount: await page.locator("#emdash-boot-loader").count(),
					}),
					{ timeout: 15_000 },
				)
				.toMatchObject({ marker: expect.stringContaining("loaded"), bootLoaderCount: 0 });
		});
	}
});
