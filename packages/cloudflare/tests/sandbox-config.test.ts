import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sandbox } from "../src/index.js";

describe("sandbox", () => {
	const originalCwd = process.cwd();
	const tempDirs: string[] = [];

	function makeFixture(content: string) {
		const dir = mkdtempSync(join(tmpdir(), "emdash-sandbox-test-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "wrangler.jsonc"), content);
		return dir;
	}

	beforeEach(() => {
		vi.stubEnv("CLOUDFLARE_ENV", undefined);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the Cloudflare sandbox runner when the LOADER binding is configured", () => {
		const dir = makeFixture(JSON.stringify({ worker_loaders: [{ binding: "LOADER" }] }));
		process.chdir(dir);

		expect(sandbox()).toBe("@emdash-cms/cloudflare/sandbox");
	});

	it("disables sandboxed plugins when Worker Loader is not configured", () => {
		const dir = makeFixture(JSON.stringify({ name: "test" }));
		process.chdir(dir);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(sandbox()).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			"[emdash] Sandboxed plugins are disabled because wrangler.jsonc has no LOADER Worker Loader binding. Worker Loader requires a Workers paid plan.",
		);

		warn.mockRestore();
	});

	it("requires the binding name used by the runtime", () => {
		const dir = makeFixture(JSON.stringify({ worker_loaders: [{ binding: "OTHER_LOADER" }] }));
		process.chdir(dir);

		expect(sandbox()).toBeUndefined();
	});

	it("reads the named environment selected by the Cloudflare Vite plugin", () => {
		vi.stubEnv("CLOUDFLARE_ENV", "staging");
		const dir = makeFixture(
			JSON.stringify({
				env: {
					staging: { worker_loaders: [{ binding: "LOADER" }] },
				},
			}),
		);
		process.chdir(dir);

		expect(sandbox()).toBe("@emdash-cms/cloudflare/sandbox");
	});

	it("returns the runner for projects configured with cloudflare.config.ts", () => {
		const dir = mkdtempSync(join(tmpdir(), "emdash-sandbox-test-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "cloudflare.config.ts"), "export default {};\n");
		process.chdir(dir);

		expect(sandbox()).toBe("@emdash-cms/cloudflare/sandbox");
	});

	it("prefers cloudflare.config.ts over a Wrangler config without LOADER", () => {
		const dir = makeFixture(JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "cloudflare.config.ts"), "export default {};\n");
		process.chdir(dir);

		expect(sandbox()).toBe("@emdash-cms/cloudflare/sandbox");
	});
});
