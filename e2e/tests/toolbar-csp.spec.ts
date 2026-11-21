import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { test, expect } from "../fixtures";

const exec = promisify(execFile);

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
	const address = server.address();
	await promisify(server.close.bind(server))();
	if (!address || typeof address === "string") throw new Error("No port allocated");
	return address.port;
}

test("the editor toolbar works under Astro's built hash-based CSP", async ({
	page,
	admin,
	serverInfo,
}) => {
	test.skip(
		process.env.EMDASH_E2E_TARGET === "cloudflare",
		"This fixture builds with the Node adapter",
	);
	test.setTimeout(180_000);
	await admin.devBypassAuth();
	const { tempDataDir } = JSON.parse(
		await readFile(join(tmpdir(), "emdash-pw-server.json"), "utf8"),
	) as { tempDataDir: string };
	await mkdir(resolvePath("e2e/.astro"), { recursive: true });
	const dir = await mkdtemp(resolvePath("e2e/.astro/toolbar-csp-"));
	const port = await freePort();
	const origin = `http://localhost:${port}`;
	let server: ReturnType<typeof spawn> | undefined;
	try {
		const database = new DatabaseSync(join(tempDataDir, "test.db"), { readOnly: true });
		try {
			await backup(database, join(dir, "test.db"));
		} finally {
			database.close();
		}
		await mkdir(join(dir, "node_modules"));
		for (const name of await readdir(resolvePath("e2e/fixture/node_modules"))) {
			await symlink(resolvePath("e2e/fixture/node_modules", name), join(dir, "node_modules", name));
		}
		await symlink(
			resolvePath("packages/core/node_modules/kysely"),
			join(dir, "node_modules/kysely"),
		);
		await mkdir(join(dir, "src/pages"), { recursive: true });
		await writeFile(join(dir, "package.json"), '{"type":"module"}');
		await writeFile(
			join(dir, "astro.config.mjs"),
			`
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";
export default defineConfig({
  output: "server",
  vite: { ssr: { noExternal: ["@astrojs/react"] } },
  adapter: node({ mode: "standalone" }),
  security: { csp: true },
  integrations: [react(), emdash({ fonts: false, database: sqlite({ url: ${JSON.stringify(`file:${join(dir, "test.db")}`)} }) })],
});
`,
		);
		const ref = JSON.stringify({
			collection: "posts",
			id: serverInfo.contentIds.posts[0],
			status: "draft",
		});
		await writeFile(
			join(dir, "src/pages/index.astro"),
			`<html><head><meta charset="utf-8" /><title>Toolbar CSP</title></head><body><h1 data-emdash-ref='${ref}'>Toolbar CSP</h1></body></html>`,
		);
		await exec(join(dir, "node_modules/.bin/astro"), ["build"], { cwd: dir, timeout: 120_000 });
		server = spawn(process.execPath, [join(dir, "dist/server/entry.mjs")], {
			cwd: dir,
			env: {
				...process.env,
				HOST: "localhost",
				PORT: String(port),
				EMDASH_ENCRYPTION_KEY: "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		server.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		server.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
		});
		await expect
			.poll(
				async () => {
					if (server!.exitCode !== null) throw new Error(output);
					try {
						return (await page.request.get(origin)).status();
					} catch {
						return 0;
					}
				},
				{ timeout: 20_000 },
			)
			.toBe(200);
		await page
			.context()
			.addCookies([{ name: "emdash-edit-mode", value: "true", domain: "localhost", path: "/" }]);
		await page.addInitScript(() => {
			Object.assign(window, { toolbarCspViolations: [] });
			document.addEventListener("securitypolicyviolation", (event) => {
				(window as unknown as { toolbarCspViolations: string[] }).toolbarCspViolations.push(
					event.effectiveDirective,
				);
			});
		});
		const response = await page.goto(origin);
		expect(response!.headers()["content-security-policy"]).toContain("sha256-");
		const toolbar = page.locator("#emdash-toolbar");
		await expect(toolbar).toBeVisible();
		expect(await toolbar.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
		await expect(page.locator("#emdash-tb-admin")).toBeVisible();
		await expect(page.locator("#emdash-tb-publish")).toBeVisible();
		expect(
			await page.evaluate(
				() => (window as unknown as { toolbarCspViolations: string[] }).toolbarCspViolations,
			),
		).toEqual([]);
		const firstToken = await toolbar.getAttribute("data-action-token");
		expect(firstToken).toBeTruthy();
		const script = await page.locator("script").last().textContent();
		await expect
			.poll(async () => {
				const reloaded = await page.reload();
				expect(reloaded!.headers()["content-security-policy"]).toBe(
					response!.headers()["content-security-policy"],
				);
				const token = await toolbar.getAttribute("data-action-token");
				expect(token).toBeTruthy();
				return token;
			})
			.not.toBe(firstToken);
		expect(await page.locator("script").last().textContent()).toBe(script);
		await page.locator("#emdash-tb-dismiss").click();
		await expect(toolbar).toHaveCount(0);
		expect(
			await page.evaluate(
				() => (window as unknown as { toolbarCspViolations: string[] }).toolbarCspViolations,
			),
		).toEqual([]);
	} finally {
		if (server && server.exitCode === null) {
			const exited = new Promise((resolve) => server!.once("exit", resolve));
			server.kill("SIGTERM");
			await exited;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
