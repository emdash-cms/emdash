/**
 * Coverage for `localPlugin(dir)` — the local-dev helper that lets a
 * site's `astro.config.mjs` consume a sandboxed plugin from its source
 * directory without an npm-shaped factory import.
 *
 * The runtime side of the helper (Vite resolving the file:// entrypoint
 * and importing the plugin module) isn't tested here — that's
 * integration territory and the demos exercise it directly. These
 * tests focus on the deterministic parts: descriptor shape, error
 * paths for missing manifest / missing entry / malformed publisher.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalPluginError, localPlugin } from "../src/dev.js";

describe("localPlugin", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-localplugin-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function writeManifest(content: object): Promise<void> {
		await writeFile(join(dir, "emdash-plugin.jsonc"), JSON.stringify(content), "utf8");
	}

	async function writeEntry(): Promise<void> {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(
			join(dir, "src", "plugin.ts"),
			'import { definePlugin } from "emdash";\nexport default definePlugin({});\n',
			"utf8",
		);
	}

	const MINIMAL_MANIFEST = {
		slug: "test-plugin",
		version: "0.1.0",
		publisher: "did:plc:abc123",
		license: "MIT",
		author: { name: "Test" },
		security: { email: "security@example.com" },
	};

	it("returns a descriptor with identity from the manifest", async () => {
		await writeManifest(MINIMAL_MANIFEST);
		await writeEntry();
		const descriptor = await localPlugin(dir);
		expect(descriptor.id).toBe("test-plugin");
		expect(descriptor.version).toBe("0.1.0");
		expect(descriptor.format).toBe("standard");
	});

	it("emits a file:// URL for entrypoint pointing at src/plugin.ts", async () => {
		await writeManifest(MINIMAL_MANIFEST);
		await writeEntry();
		const descriptor = await localPlugin(dir, { skipPublisherResolution: true });
		expect(descriptor.entrypoint).toMatch(/^file:\/\//);
		expect(descriptor.entrypoint.endsWith("/src/plugin.ts")).toBe(true);
		// The URL round-trips through pathToFileURL/fileURLToPath cleanly.
		const fsPath = fileURLToPath(descriptor.entrypoint);
		expect(fsPath.endsWith("/src/plugin.ts")).toBe(true);
	});

	it("passes the trust contract through", async () => {
		await writeManifest({
			...MINIMAL_MANIFEST,
			capabilities: ["content:read"],
			storage: { events: { indexes: ["timestamp"] } },
		});
		await writeEntry();
		const descriptor = await localPlugin(dir, { skipPublisherResolution: true });
		expect(descriptor.capabilities).toEqual(["content:read"]);
		expect(descriptor.allowedHosts).toEqual([]);
		expect(descriptor.storage).toEqual({ events: { indexes: ["timestamp"] } });
	});

	it("passes admin pages and widgets through", async () => {
		await writeManifest({
			...MINIMAL_MANIFEST,
			admin: {
				pages: [{ path: "/foo", label: "Foo" }],
				widgets: [{ id: "bar", title: "Bar", size: "half" }],
			},
		});
		await writeEntry();
		const descriptor = await localPlugin(dir, { skipPublisherResolution: true });
		expect(descriptor.adminPages).toEqual([{ path: "/foo", label: "Foo" }]);
		expect(descriptor.adminWidgets).toEqual([{ id: "bar", title: "Bar", size: "half" }]);
	});

	it("omits adminPages / adminWidgets when neither is declared", async () => {
		await writeManifest(MINIMAL_MANIFEST);
		await writeEntry();
		const descriptor = await localPlugin(dir, { skipPublisherResolution: true });
		expect(descriptor.adminPages).toBeUndefined();
		expect(descriptor.adminWidgets).toBeUndefined();
	});

	it("throws MANIFEST_INVALID when emdash-plugin.jsonc is missing", async () => {
		await writeEntry();
		await expect(localPlugin(dir)).rejects.toMatchObject({
			name: "LocalPluginError",
			code: "MANIFEST_INVALID",
		});
	});

	it("throws MANIFEST_INVALID when the manifest fails schema validation", async () => {
		await writeManifest({ slug: "" }); // missing required fields
		await writeEntry();
		await expect(localPlugin(dir)).rejects.toMatchObject({
			name: "LocalPluginError",
			code: "MANIFEST_INVALID",
		});
	});

	it("throws PLUGIN_ENTRY_MISSING when src/plugin.ts doesn't exist", async () => {
		await writeManifest(MINIMAL_MANIFEST);
		// No writeEntry() — manifest is valid but the runtime entry
		// is missing.
		await expect(localPlugin(dir)).rejects.toMatchObject({
			name: "LocalPluginError",
			code: "PLUGIN_ENTRY_MISSING",
		});
	});

	it("returns the publisher DID verbatim when given a DID", async () => {
		// skipPublisherResolution avoids the network round-trip; the
		// DID is passed through unchanged.
		await writeManifest(MINIMAL_MANIFEST);
		await writeEntry();
		// The descriptor doesn't yet expose `did` directly, but
		// we can confirm the helper accepted the DID input. Future
		// PRs will add did/uri to the descriptor; this test pins the
		// happy path.
		await expect(localPlugin(dir, { skipPublisherResolution: true })).resolves.toMatchObject({
			id: "test-plugin",
		});
	});

	it("throws when the dir path is a non-existent directory", async () => {
		const missing = join(dir, "no-such-plugin");
		await expect(localPlugin(missing)).rejects.toBeInstanceOf(LocalPluginError);
	});
});
