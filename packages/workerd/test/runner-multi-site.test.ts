import type { PluginManifest } from "emdash";
import { describe, expect, it } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

let workerdAvailable = false;
try {
	const runner = new WorkerdSandboxRunner({ db: null as any });
	workerdAvailable = runner.isAvailable();
	await runner.terminateAll();
} catch {
	// The optional workerd binary is not installed in every test environment.
}

const manifest: PluginManifest = {
	id: "multi-site-echo",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: ["plugin:activate"],
	routes: [],
	admin: {},
};

const extraManifest: PluginManifest = {
	...manifest,
	id: "multi-site-restart",
};

function pluginCode(site: string): string {
	return `export default {
		hooks: {
			"plugin:activate": async () => ({ site: ${JSON.stringify(site)} })
		}
	};`;
}

describe.skipIf(!workerdAvailable)("WorkerdSandboxRunner multi-site isolation", () => {
	it("keeps concurrent runners and their cached plugins isolated across restarts and churn", async () => {
		const siteA = new WorkerdSandboxRunner({ db: null as any });
		const siteB = new WorkerdSandboxRunner({ db: null as any });
		siteA["scheduleEagerStart"] = () => {};
		siteB["scheduleEagerStart"] = () => {};

		try {
			const [pluginA, pluginB] = await Promise.all([
				siteA.load(manifest, pluginCode("site-a")),
				siteB.load(manifest, pluginCode("site-b")),
			]);
			const cachedA = await siteA.load(manifest, pluginCode("wrong-marker"));
			const cachedB = await siteB.load(manifest, pluginCode("wrong-marker"));

			await Promise.all([siteA.ensureRunning(), siteB.ensureRunning()]);
			expect(await pluginA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await cachedA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await pluginB.invokeHook("plugin:activate", {})).toEqual({ site: "site-b" });
			expect(await cachedB.invokeHook("plugin:activate", {})).toEqual({ site: "site-b" });

			const extraA = await siteA.load(extraManifest, pluginCode("site-a-extra"));
			await siteA.ensureRunning();
			expect(await pluginA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await cachedA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await pluginB.invokeHook("plugin:activate", {})).toEqual({ site: "site-b" });

			await extraA.terminate();
			const reloadedExtraA = await siteA.load(extraManifest, pluginCode("site-a-extra-reloaded"));
			expect(await reloadedExtraA.invokeHook("plugin:activate", {})).toEqual({
				site: "site-a-extra-reloaded",
			});
			expect(await pluginA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await cachedA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await pluginB.invokeHook("plugin:activate", {})).toEqual({ site: "site-b" });
			const child = siteA["workerdProcess"];
			if (!child) throw new Error("workerd did not start");
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;
			await siteA.ensureRunning({ waitForPendingRestart: true });
			expect(await cachedA.invokeHook("plugin:activate", {})).toEqual({ site: "site-a" });
			expect(await pluginB.invokeHook("plugin:activate", {})).toEqual({ site: "site-b" });
		} finally {
			await Promise.all([siteA.terminateAll(), siteB.terminateAll()]);
		}
	}, 30_000);
});
