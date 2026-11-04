import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

interface WorkerOptions {
	miniflare: {
		bindings: { EMDASH_PLUGIN_CODE: string; EMDASH_PLUGIN_MANIFEST: string };
	};
}

type BuildOptions = { dir: string; outDir?: string };

const mocks = vi.hoisted(() => {
	let setupCallback: (() => Promise<WorkerOptions>) | undefined;
	const buildPlugin = vi.fn();
	const cloudflareTest = vi.fn((callback: () => Promise<WorkerOptions>) => {
		setupCallback = callback;
		return { name: "mock-cloudflare-test" };
	});
	return { buildPlugin, cloudflareTest, getSetup: () => setupCallback! };
});

vi.mock("@cloudflare/vitest-plugin", () => ({ cloudflareTest: mocks.cloudflareTest }));
vi.mock("@emdash-cms/plugin-cli", () => ({ buildPlugin: mocks.buildPlugin }));

import { emdashPluginTest } from "../../src/config.js";

const cleanupDirs = new Set<string>();

async function setupTest() {
	const root = await mkdtemp(join(tmpdir(), "plugin-test-config-"));
	cleanupDirs.add(root);
	void emdashPluginTest({ dir: root });
	return mocks.getSetup();
}

function outputPath(options: BuildOptions) {
	const outDir = options.outDir ?? join(options.dir, "dist");
	cleanupDirs.add(outDir);
	return outDir;
}

async function bindings(setup: () => Promise<WorkerOptions>) {
	return (await setup()).miniflare.bindings;
}

afterEach(async () => {
	mocks.buildPlugin.mockReset();
	await Promise.all(Array.from(cleanupDirs, (dir) => rm(dir, { recursive: true, force: true })));
	cleanupDirs.clear();
});

describe("emdashPluginTest build isolation", () => {
	it("keeps concurrent builds and reads isolated", async () => {
		const setup = await setupTest();
		const readyA = deferred();
		const releaseA = deferred();
		const readyB = deferred();
		const releaseB = deferred();
		let buildNumber = 0;
		mocks.buildPlugin.mockImplementation(async (options: BuildOptions) => {
			const number = ++buildNumber;
			const outDir = outputPath(options);
			await mkdir(outDir, { recursive: true });
			const runtime = join(outDir, "runtime.mjs");
			const manifestJson = join(outDir, "manifest.json");
			if (number === 1) {
				await writeFile(runtime, "plugin-1");
				await writeFile(manifestJson, JSON.stringify({ id: "plugin-1" }));
				readyA.resolve();
				await releaseA.promise;
			} else {
				// Hold a second manifest write open while the first setup reads its artifacts.
				await writeFile(manifestJson, "");
				readyB.resolve();
				await releaseB.promise;
				await writeFile(runtime, "plugin-2");
				await writeFile(manifestJson, JSON.stringify({ id: "plugin-2" }));
			}
			return { files: { runtime, manifestJson } };
		});
		const first = bindings(setup);
		await readyA.promise;
		const second = bindings(setup);
		try {
			await readyB.promise;
			releaseA.resolve();
			const firstBindings = await first;
			releaseB.resolve();
			const secondBindings = await second;
			expect(JSON.parse(firstBindings.EMDASH_PLUGIN_MANIFEST)).toEqual({ id: "plugin-1" });
			expect(firstBindings.EMDASH_PLUGIN_CODE).toBe("plugin-1");
			expect(secondBindings.EMDASH_PLUGIN_CODE).toBe("plugin-2");
			expect(JSON.parse(secondBindings.EMDASH_PLUGIN_MANIFEST)).toEqual({ id: "plugin-2" });
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it.each(["success", "build failure", "artifact read failure"])(
		"cleans temporary output after %s",
		async (name) => {
			const setup = await setupTest();
			let outDir = "";
			mocks.buildPlugin.mockImplementation(async (options: BuildOptions) => {
				outDir = outputPath(options);
				await mkdir(outDir, { recursive: true });
				if (name === "build failure") throw new Error("build failed");
				const runtime = join(outDir, "runtime.mjs");
				const manifestJson = join(outDir, "manifest.json");
				await writeFile(runtime, "runtime");
				if (name === "success") await writeFile(manifestJson, "{}");
				return { files: { runtime, manifestJson } };
			});
			if (name === "success") await setup();
			else
				await expect(setup()).rejects.toThrow(name === "build failure" ? "build failed" : "ENOENT");
			expect(outDir).not.toBe("");
			await expect(access(outDir)).rejects.toThrow("ENOENT");
		},
	);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}
