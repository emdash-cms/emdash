import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PublishingClient, type Did } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { afterEach, describe, expect, it } from "vitest";

import { diffCapabilities, diffRouteVisibility } from "../../core/src/api/handlers/marketplace.js";
import { bundlePlugin } from "../src/api.js";
import { buildPlugin } from "../src/build/api.js";
import { publishRelease } from "../src/publish/api.js";
import { MockPds } from "./mock-pds.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../plugins/marketplace-test");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("registry fixture artifact round trip", () => {
	it("preserves maximal authority from source through bundle, descriptor, and registry record", async () => {
		const output = await mkdtemp(join(tmpdir(), "emdash-registry-fixture-"));
		temporaryDirectories.push(output);
		const build = await buildPlugin({ dir: fixture, outDir: output });
		const bundle = await bundlePlugin({ dir: fixture, outDir: output });
		const persistedManifest = JSON.parse(
			await readFile(build.files.manifestJson, "utf8"),
		) as typeof bundle.manifest;
		const descriptorModule = await import(
			`${pathToFileURL(build.files.descriptor!).href}?test=${Date.now()}`
		);
		const runtimeModule = await import(
			`${pathToFileURL(build.files.runtime).href}?runtime-test=${Date.now()}`
		);
		const descriptor = descriptorModule.default as Record<string, unknown>;
		const runtime = runtimeModule.default as Record<string, unknown>;
		const runtimeSource = await readFile(build.files.runtime, "utf8");

		expect(bundle.tarballBytes).toBeGreaterThan(0);
		expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(persistedManifest).toEqual(bundle.manifest);
		expect(Object.keys(runtime).toSorted()).toEqual(["hooks", "routes"]);
		expect(runtimeSource).not.toContain("runDiagnostics");
		expect(runtimeSource).not.toContain("deleteRecord");
		expect(Buffer.byteLength(runtimeSource)).toBeLessThan(60_000);
		expect(descriptor).toMatchObject({
			capabilities: persistedManifest.capabilities,
			hooks: persistedManifest.hooks,
			routes: persistedManifest.routes,
			mcp: persistedManifest.mcp,
			settingsSchema: persistedManifest.admin.settingsSchema,
			fieldWidgets: persistedManifest.admin.fieldWidgets,
			editorPanels: persistedManifest.admin.editorPanels,
			editorActions: persistedManifest.admin.editorActions,
		});
		expect(persistedManifest.mcp?.tools).toEqual([
			expect.objectContaining({ name: "runDiagnostics", destructive: false }),
			expect.objectContaining({ name: "deleteRecord", destructive: true }),
		]);
		expect(
			persistedManifest.routes.filter((route) => typeof route !== "string" && route.public === true)
				.length,
		).toBeGreaterThan(0);
		expect(new Set(diffCapabilities([], persistedManifest.capabilities).added)).toEqual(
			new Set(persistedManifest.capabilities),
		);
		const publicRoutes = persistedManifest.routes
			.filter((route) => typeof route !== "string" && route.public === true)
			.map((route) => (typeof route === "string" ? route : route.name));
		expect(diffRouteVisibility(undefined, persistedManifest).newlyPublic).toEqual(publicRoutes);

		const did = "did:plc:xyraubanwc5fwemkduw3upi6" as Did;
		const pds = new MockPds({ did });
		await publishRelease({
			publisher: PublishingClient.fromHandler({
				handler: pds,
				did,
				pds: "https://pds.example.test",
			}),
			did,
			manifest: persistedManifest,
			checksum: bundle.sha256!,
			url: "https://registry.example.test/marketplace-test.tgz",
			repo: "https://github.com/emdash-cms/emdash",
			profile: {
				license: "MIT",
				authorName: "EmDash",
				securityUrl: "https://github.com/emdash-cms/emdash/security/advisories/new",
			},
		});

		const release = pds.records.get(
			`at://${did}/${NSID.packageRelease}/marketplace-test:${persistedManifest.version}`,
		);
		expect(release).toBeDefined();
		if (!release) throw new Error("Registry fixture release record was not written");
		const extension = (
			release.value as {
				extensions: Record<string, { declaredAccess: unknown }>;
			}
		).extensions[NSID.packageReleaseExtension];
		expect(extension?.declaredAccess).toEqual(persistedManifest.declaredAccess);
	});
});
