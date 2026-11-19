import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "tsdown";
import { describe, expect, it } from "vitest";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const workerdBinary = join(packageDir, "node_modules/workerd/bin/workerd");
let canRun = process.platform !== "win32" && existsSync(workerdBinary);
if (canRun) {
	try {
		execFileSync(workerdBinary, ["--version"], { stdio: "ignore", timeout: 5_000 });
	} catch {
		canRun = false;
	}
}

const consumerScript = (modulePath: string) => `
import assert from "node:assert/strict";
import { createSandboxRunner } from ${JSON.stringify(modulePath)};

const runner = createSandboxRunner({ db: null });
try {
  const plugin = await runner.load(
    { id: "consumer-bundle", version: "1.0.0", capabilities: [], allowedHosts: [], storage: {}, hooks: ["test"], routes: [], admin: {} },
    "export default { hooks: { test: async () => ({ bundled: true }) } };",
  );
  assert.deepEqual(await plugin.invokeHook("test", {}), { bundled: true });
} finally {
  await runner.terminateAll();
}
`;

describe.skipIf(!canRun)("consumer bundles", () => {
	it("runs the sandbox when the consumer bundle has no copied shell assets", async () => {
		const consumerDir = mkdtempSync(join(tmpdir(), "emdash consumer [bundle]-"));
		const outDir = join(consumerDir, "output");
		const scriptPath = join(consumerDir, "run consumer!.mjs");
		let child: ReturnType<typeof spawn> | undefined;

		try {
			await build({
				entry: join(packageDir, "src/sandbox/index.ts"),
				format: ["esm"],
				outDir,
				clean: true,
				dts: false,
				config: false,
				tsconfig: false,
				report: false,
				external: ["emdash", "workerd", "miniflare"],
			});

			symlinkSync(join(packageDir, "node_modules"), join(consumerDir, "node_modules"));
			const bundles = readdirSync(outDir).filter((file) => file.endsWith(".mjs"));
			expect(bundles).toHaveLength(1);
			expect(readdirSync(outDir).some((file) => file.endsWith(".sh"))).toBe(false);

			writeFileSync(scriptPath, consumerScript(pathToFileURL(join(outDir, bundles[0]!)).href));
			child = spawn(process.execPath, [scriptPath], {
				env: { ...process.env, NODE_ENV: "production", EMDASH_SANDBOX_DEV: "0" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
			child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(resolve, reject) => {
					const timer = setTimeout(() => {
						child?.kill("SIGKILL");
						reject(new Error(`consumer bundle timed out; stdout: ${stdout}; stderr: ${stderr}`));
					}, 25_000);
					child?.once("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child?.once("exit", (code, signal) => {
						clearTimeout(timer);
						resolve({ code, signal });
					});
				},
			);
			expect(result, `${stdout}\n${stderr}`).toEqual({ code: 0, signal: null });
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						exited,
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 2_000);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}
			}
			rmSync(consumerDir, { recursive: true, force: true });
		}
	}, 30_000);
});
