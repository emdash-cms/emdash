import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { PluginManifest } from "emdash";
import { afterEach, describe, expect, it } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

let workerdAvailable = false;
try {
	const runner = new WorkerdSandboxRunner({ db: null as never });
	workerdAvailable = runner.isAvailable();
	await runner.terminateAll();
} catch {
	// The optional workerd binary is not installed in every test environment.
}

const MANIFEST: PluginManifest = {
	id: "config-dir-permissions",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};

// Windows has no POSIX permission bits to assert on.
describe.skipIf(!workerdAvailable || process.platform === "win32")(
	"WorkerdSandboxRunner config directory permissions",
	() => {
		let runner: WorkerdSandboxRunner | undefined;

		afterEach(async () => {
			await runner?.terminateAll();
		});

		it("keeps the config directory and plugin wrappers private to the server's user", async () => {
			const previousUmask = process.umask(0o022);
			try {
				runner = new WorkerdSandboxRunner({ db: null as never });
				runner["scheduleEagerStart"] = () => {};
				await runner.load(MANIFEST, "export default {};");
				await runner.ensureRunning();
			} finally {
				process.umask(previousUmask);
			}

			const configDir = runner["configDir"];
			if (!configDir) throw new Error("config directory was not created");
			expect((await stat(configDir)).mode & 0o077).toBe(0);

			const wrappers = (await readdir(configDir)).filter((file) => file.endsWith("-wrapper.js"));
			expect(wrappers).toHaveLength(1);
			expect((await stat(join(configDir, wrappers[0]!))).mode & 0o077).toBe(0);
		});
	},
);
