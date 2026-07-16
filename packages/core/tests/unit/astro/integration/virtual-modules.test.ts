import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	generateConfigModule,
	generateDialectModule,
	generateSchedulerModule,
	generateSeedModule,
	RESOLVED_VIRTUAL_SCHEDULER_ID,
} from "../../../../src/astro/integration/virtual-modules.js";
import {
	createVirtualModulesPlugin,
	type VitePluginOptions,
} from "../../../../src/astro/integration/vite-config.js";

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
		const out = generateDialectModule({
			supportsRequestScope: false,
			supportsCoalescing: false,
		});
		expect(out).toContain("export const createDialect = undefined");
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
	});

	it("emits a null stub for adapters that don't support request scoping", () => {
		const out = generateDialectModule({
			entrypoint: "some-adapter/dialect",
			type: "sqlite",
			supportsRequestScope: false,
			supportsCoalescing: false,
		});
		expect(out).toContain(`import { createDialect as _createDialect } from "some-adapter/dialect"`);
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
		expect(out).toContain("export const createCoalescingDialect = undefined");
		expect(out).not.toContain("_dialectModule.createCoalescingDialect");
		expect(out).not.toContain(`export { createRequestScopedDb } from`);
	});

	it("re-exports createRequestScopedDb from the adapter when supportsRequestScope is true", () => {
		const out = generateDialectModule({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
			type: "sqlite",
			supportsRequestScope: true,
			supportsCoalescing: true,
		});
		expect(out).toContain(`export { createRequestScopedDb } from "@emdash-cms/cloudflare/db/d1"`);
		expect(out).toContain(
			`import { createCoalescingDialect as _createCoalescingDialect } from "@emdash-cms/cloudflare/db/d1"`,
		);
		expect(out).toContain("export const createCoalescingDialect = _createCoalescingDialect");
		expect(out).not.toContain("= () => null");
		expect(out).not.toContain("= (_opts) => null");
	});

	it("threads the dialect type through", () => {
		const out = generateDialectModule({
			entrypoint: "emdash/db/postgres",
			type: "postgres",
			supportsRequestScope: false,
			supportsCoalescing: false,
		});
		expect(out).toContain(`export const dialectType = "postgres"`);
	});
});

describe("generateSchedulerModule", () => {
	it("disables the timer for a Cloudflare production build (Cron Trigger drives it)", () => {
		const out = generateSchedulerModule("@astrojs/cloudflare", "build");
		expect(out).toContain("export const createScheduler = null");
		expect(out).not.toContain("NodeCronScheduler");
	});

	it("keeps the Node timer in local dev even under the Cloudflare adapter", () => {
		// No Cron Trigger fires in `astro dev`, so scheduled publishing/cron
		// must still run via the in-process timer.
		const out = generateSchedulerModule("@astrojs/cloudflare", "serve");
		expect(out).toContain('import { NodeCronScheduler } from "emdash"');
		expect(out).toContain("export function createScheduler(executor)");
		expect(out).not.toContain("createScheduler = null");
	});

	it("emits a NodeCronScheduler factory for non-Cloudflare adapters", () => {
		for (const cmd of ["build", "serve", undefined] as const) {
			const out = generateSchedulerModule("@astrojs/node", cmd);
			expect(out).toContain('import { NodeCronScheduler } from "emdash"');
			expect(out).not.toContain("createScheduler = null");
		}
	});

	it("emits a NodeCronScheduler factory when no adapter is configured", () => {
		const out = generateSchedulerModule(undefined, "build");
		expect(out).toContain("export function createScheduler(executor)");
	});
});

describe("createVirtualModulesPlugin scheduler wiring", () => {
	// Invoke a Vite plugin hook that may be a function or { handler } object.
	function callHook<T>(hook: unknown, ...args: unknown[]): T {
		const fn = typeof hook === "function" ? hook : (hook as { handler: unknown }).handler;
		return (fn as (...a: unknown[]) => T)(...args);
	}

	function buildPlugin(
		adapterName: string | undefined,
		command: "dev" | "build" | "preview" | "sync",
	): Plugin {
		const options = {
			serializableConfig: {},
			resolvedConfig: {},
			pluginDescriptors: [],
			astroConfig: { adapter: adapterName ? { name: adapterName } : undefined },
		} as unknown as VitePluginOptions;
		return createVirtualModulesPlugin(options, command);
	}

	it("keeps the Node timer under the Cloudflare adapter during `astro dev` even when Vite reports command 'build'", () => {
		// The Cloudflare adapter produces the worker bundle via a nested Vite
		// *build* pass during `astro dev`, so Vite's config.command resolves to
		// "build". The scheduler decision must use Astro's command ("dev")
		// instead, otherwise plugin cron silently no-ops in local dev (#1635).
		const plugin = buildPlugin("@astrojs/cloudflare", "dev");
		callHook(plugin.configResolved, { command: "build" });

		const out = callHook<string>(plugin.load, RESOLVED_VIRTUAL_SCHEDULER_ID);
		expect(out).toContain('import { NodeCronScheduler } from "emdash"');
		expect(out).not.toContain("createScheduler = null");
	});

	it("disables the timer under the Cloudflare adapter for a production build", () => {
		const plugin = buildPlugin("@astrojs/cloudflare", "build");
		callHook(plugin.configResolved, { command: "build" });

		const out = callHook<string>(plugin.load, RESOLVED_VIRTUAL_SCHEDULER_ID);
		expect(out).toContain("export const createScheduler = null");
		expect(out).not.toContain("NodeCronScheduler");
	});
});

describe("generateSeedModule", () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = mkdtempSync(join(tmpdir(), "emdash-seed-test-"));
	});

	afterEach(() => {
		rmSync(projectRoot, { recursive: true, force: true });
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

	it("falls through to the default seed when no user seed is found", () => {
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "x" }));

		const out = generateSeedModule(projectRoot);
		expect(out).toContain("export const userSeed = null;");
		expect(out).toContain("export const seed = ");
	});
});
