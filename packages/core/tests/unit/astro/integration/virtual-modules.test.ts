import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	generateConfigModule,
	generateDialectModule,
	generateSeedModule,
} from "../../../../src/astro/integration/virtual-modules.js";

describe("generateConfigModule", () => {
	it("round-trips the serialisable config shape via default export", () => {
		const source = generateConfigModule({
			siteUrl: "https://example.com",
			trustedProxyHeaders: ["x-real-ip", "fly-client-ip"],
			maxUploadSize: 52_428_800,
		});
		// The virtual module is `export default <JSON>` — eval by stripping
		// the prefix and parsing.
		const prefix = "export default ";
		expect(source.startsWith(prefix)).toBe(true);
		const json = source.slice(prefix.length).replace(/;$/, "");
		const parsed = JSON.parse(json);
		expect(parsed.trustedProxyHeaders).toEqual(["x-real-ip", "fly-client-ip"]);
		expect(parsed.siteUrl).toBe("https://example.com");
	});
});

describe("generateDialectModule", () => {
	it("emits undefined createDialect and null stub when no entrypoint is configured", () => {
		const out = generateDialectModule({ supportsRequestScope: false });
		expect(out).toContain("export const createDialect = undefined");
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
	});

	it("emits a null stub for adapters that don't support request scoping", () => {
		const out = generateDialectModule({
			entrypoint: "some-adapter/dialect",
			type: "sqlite",
			supportsRequestScope: false,
		});
		expect(out).toContain(`import { createDialect as _createDialect } from "some-adapter/dialect"`);
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
		expect(out).not.toContain(`export { createRequestScopedDb } from`);
	});

	it("re-exports createRequestScopedDb from the adapter when supportsRequestScope is true", () => {
		const out = generateDialectModule({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
			type: "sqlite",
			supportsRequestScope: true,
		});
		expect(out).toContain(`export { createRequestScopedDb } from "@emdash-cms/cloudflare/db/d1"`);
		expect(out).not.toContain("= () => null");
		expect(out).not.toContain("= (_opts) => null");
	});

	it("threads the dialect type through", () => {
		const out = generateDialectModule({
			entrypoint: "emdash/db/postgres",
			type: "postgres",
			supportsRequestScope: false,
		});
		expect(out).toContain(`export const dialectType = "postgres"`);
	});
});

describe("generateSeedModule", () => {
	let projectRoot: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "emdash-seed-test-"));
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	const sampleSeed = (name: string) => ({
		version: "1",
		meta: { name },
		collections: [],
	});

	it("prefers .emdash/seed.json over package.json#emdash.seed and seed/seed.json", () => {
		mkdirSync(join(projectRoot, ".emdash"));
		writeFileSync(
			join(projectRoot, ".emdash", "seed.json"),
			JSON.stringify(sampleSeed("dot-emdash")),
		);

		writeFileSync(
			join(projectRoot, "package.json"),
			JSON.stringify({ name: "x", emdash: { seed: "custom-seed.json" } }),
		);
		writeFileSync(join(projectRoot, "custom-seed.json"), JSON.stringify(sampleSeed("pkg-pointer")));

		mkdirSync(join(projectRoot, "seed"));
		writeFileSync(
			join(projectRoot, "seed", "seed.json"),
			JSON.stringify(sampleSeed("conventional")),
		);

		const out = generateSeedModule(projectRoot);
		expect(out).toContain(`"name":"dot-emdash"`);
		expect(out).toContain("export const seed = userSeed;");
	});

	it("uses package.json#emdash.seed when .emdash/seed.json is absent", () => {
		writeFileSync(
			join(projectRoot, "package.json"),
			JSON.stringify({ name: "x", emdash: { seed: "seed/seed.json" } }),
		);
		mkdirSync(join(projectRoot, "seed"));
		writeFileSync(join(projectRoot, "seed", "seed.json"), JSON.stringify(sampleSeed("via-pkg")));

		const out = generateSeedModule(projectRoot);
		expect(out).toContain(`"name":"via-pkg"`);
	});

	it("falls back to seed/seed.json when no pointer is configured", () => {
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "x" }));
		mkdirSync(join(projectRoot, "seed"));
		writeFileSync(
			join(projectRoot, "seed", "seed.json"),
			JSON.stringify(sampleSeed("conventional-fallback")),
		);

		const out = generateSeedModule(projectRoot);
		expect(out).toContain(`"name":"conventional-fallback"`);
		expect(out).toContain("export const seed = userSeed;");
	});

	it("falls through to the default seed and warns when no user seed is found", () => {
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "x" }));

		const out = generateSeedModule(projectRoot);
		expect(out).toContain("export const userSeed = null;");
		expect(out).toContain("export const seed = ");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toMatch(/No user seed found/);
	});
});
