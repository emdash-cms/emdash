import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BundleError, bundlePlugin, type PluginManifest } from "../src/api.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/minimal-plugin", import.meta.url));
const BAD_FIXTURE = fileURLToPath(new URL("./fixtures/bad-plugin", import.meta.url));

/**
 * End-to-end bundling: invoke `bundlePlugin` against a real plugin source
 * directory, assert the resulting tarball + manifest match expectations.
 *
 * Each test runs the bundler at a different `outDir` under a fresh tempdir so
 * concurrent runs don't collide, and so `--outDir` resolution works as
 * advertised (it can be either absolute or relative to `dir`).
 */
describe("bundlePlugin", () => {
	let outDir: string;

	beforeEach(async () => {
		outDir = await mkdtemp(join(tmpdir(), "emdash-bundle-"));
	});

	afterEach(async () => {
		await rm(outDir, { recursive: true, force: true });
	});

	it("produces a tarball + manifest for a minimal valid plugin", async () => {
		const result = await bundlePlugin({ dir: FIXTURE, outDir });

		expect(result.manifest.id).toBe("fixture-minimal");
		expect(result.manifest.version).toBe("1.2.3");
		expect(result.manifest.capabilities).toEqual(["content:read"]);
		expect(result.manifest.allowedHosts).toEqual(["api.example.com"]);
		expect(result.tarballPath).not.toBeNull();
		expect(result.tarballPath).toMatch(/fixture-minimal-1\.2\.3\.tar\.gz$/);
		expect(result.tarballBytes).toBeGreaterThan(0);
		expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("captures hooks and routes from the sandbox-entry probe", async () => {
		const result = await bundlePlugin({ dir: FIXTURE, outDir });
		const manifest = result.manifest;

		// Plain hook name (defaults).
		expect(manifest.hooks).toContain("content:beforeCreate");
		// Routes are extracted from the sandbox entry's default export.
		expect(manifest.routes).toContain("admin");
	});

	it("validateOnly returns the manifest but writes no tarball", async () => {
		const result = await bundlePlugin({
			dir: FIXTURE,
			outDir,
			validateOnly: true,
		});
		expect(result.manifest.id).toBe("fixture-minimal");
		expect(result.tarballPath).toBeNull();
		expect(result.tarballBytes).toBeNull();
		expect(result.sha256).toBeNull();
	});

	it("the tarball contains manifest.json + backend.js with the expected manifest body", async () => {
		const result = await bundlePlugin({ dir: FIXTURE, outDir });
		expect(result.tarballPath).not.toBeNull();
		const tarballBytes = await readFile(result.tarballPath!);

		const { unpackTar, createGzipDecoder } = await import("modern-tar");
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(tarballBytes);
				controller.close();
			},
		});
		const decoded = source.pipeThrough(createGzipDecoder()) as ReadableStream<Uint8Array>;
		const entries = await unpackTar(decoded);

		const names = entries.map((e) => e.header.name).toSorted();
		expect(names).toContain("manifest.json");
		expect(names).toContain("backend.js");

		const manifestEntry = entries.find((e) => e.header.name === "manifest.json");
		expect(manifestEntry?.data).toBeDefined();
		const parsed = JSON.parse(new TextDecoder().decode(manifestEntry!.data!)) as PluginManifest;
		expect(parsed.id).toBe("fixture-minimal");
		expect(parsed.version).toBe("1.2.3");
	});

	it("throws BundleError(MISSING_PACKAGE_JSON) for a directory with no package.json", async () => {
		const empty = await mkdtemp(join(tmpdir(), "emdash-empty-"));
		try {
			await expect(bundlePlugin({ dir: empty, outDir })).rejects.toMatchObject({
				name: "BundleError",
				code: "MISSING_PACKAGE_JSON",
			});
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	it("BundleError instances are structurally identifiable", async () => {
		const empty = await mkdtemp(join(tmpdir(), "emdash-empty-"));
		try {
			let caught: unknown;
			try {
				await bundlePlugin({ dir: empty, outDir });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(BundleError);
			expect((caught as BundleError).code).toBe("MISSING_PACKAGE_JSON");
			expect((caught as BundleError).message).toMatch(/No package\.json/);
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	it("forwards progress messages through the optional logger", async () => {
		const messages: Array<{ kind: string; msg: string }> = [];
		await bundlePlugin({
			dir: FIXTURE,
			outDir,
			logger: {
				start: (m) => messages.push({ kind: "start", msg: m }),
				info: (m) => messages.push({ kind: "info", msg: m }),
				success: (m) => messages.push({ kind: "success", msg: m }),
				warn: (m) => messages.push({ kind: "warn", msg: m }),
			},
		});

		// Spot-check: bundle starts with "Bundling plugin..." and ends with a
		// "Created ..." success line. Don't pin every intermediate step --
		// they're implementation detail.
		expect(messages[0]).toMatchObject({ kind: "start", msg: /Bundling/ });
		expect(messages.some((m) => m.kind === "success" && /Created/.test(m.msg))).toBe(true);
	});

	it("validateOnly bundles never write the tarball even if outDir exists", async () => {
		// outDir already exists from beforeEach; validateOnly must not put a
		// tarball into it.
		const result = await bundlePlugin({
			dir: FIXTURE,
			outDir,
			validateOnly: true,
		});
		expect(result.tarballPath).toBeNull();

		const fs = await import("node:fs/promises");
		const contents = await fs.readdir(outDir);
		expect(contents).toEqual([]);
	});

	it("hard-fails when descriptor declares hooks but no sandbox entry exists", async () => {
		// The bad-plugin fixture declares hooks in its descriptor but has no
		// `src/sandbox-entry.ts` and no `./sandbox` export. Without the guard,
		// the bundler would silently emit a manifest claiming hooks the
		// bundle can't deliver.
		await expect(bundlePlugin({ dir: BAD_FIXTURE, outDir })).rejects.toMatchObject({
			name: "BundleError",
			code: "INVALID_PLUGIN_FORMAT",
		});
	});

	it("does not collide between concurrent bundle runs", async () => {
		// Each bundle invocation gets its own mkdtemp dir; running two in
		// parallel must not corrupt each other.
		const [a, b] = await Promise.all([
			bundlePlugin({ dir: FIXTURE, outDir, validateOnly: true }),
			bundlePlugin({ dir: FIXTURE, outDir, validateOnly: true }),
		]);
		expect(a.manifest.id).toBe("fixture-minimal");
		expect(b.manifest.id).toBe("fixture-minimal");
	});
});
