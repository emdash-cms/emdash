import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareReleaseFiles } from "../src/prepare.js";

const PACKAGE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
const PROVENANCE_BYTES = new TextEncoder().encode('{"sigstore":"bundle"}\n');
const PACKAGE_CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROVENANCE_CHECKSUM = "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const validationDependencies = {
	validateBundle: async () => ({
		success: true as const,
		value: { packageSlug: "gallery", version: "1.2.3", declaredAccess: {} },
	}),
	computeChecksum: async (bytes: Uint8Array) =>
		bytes.byteLength === PACKAGE_BYTES.byteLength ? PACKAGE_CHECKSUM : PROVENANCE_CHECKSUM,
};

describe("release Action file preparation", () => {
	let root: string;
	let workspace: string;
	let runnerTemp: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "emdash-release-action-"));
		workspace = join(root, "workspace");
		runnerTemp = join(root, "runner-temp");
		await Promise.all([
			mkdir(join(workspace, "artifacts"), { recursive: true }),
			mkdir(runnerTemp, { recursive: true }),
		]);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("loads a workspace bundle and exact RUNNER_TEMP attestation bytes", async () => {
		const bundlePath = join(workspace, "artifacts", "gallery.tar.gz");
		const provenancePath = join(runnerTemp, "attestation.json");
		await Promise.all([
			writeFile(bundlePath, PACKAGE_BYTES),
			writeFile(provenancePath, PROVENANCE_BYTES),
		]);

		const prepared = await prepareReleaseFiles(
			{
				workspace,
				runnerTemp,
				bundleFile: "artifacts/gallery.tar.gz",
				provenanceFile: provenancePath,
				repository: "example/gallery",
				workflowRef: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
				repositoryVisibility: "public",
			},
			validationDependencies,
		);

		expect(prepared).toMatchObject({
			packageSlug: "gallery",
			version: "1.2.3",
			packageBytes: PACKAGE_BYTES,
			provenanceBytes: PROVENANCE_BYTES,
			sourceRepository: "https://github.com/example/gallery",
			builderId:
				"https://github.com/example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
		});
	});

	it("builds a project when no bundle is supplied", async () => {
		const bundlePath = join(workspace, "generated.tar.gz");
		const provenancePath = join(runnerTemp, "attestation.json");
		await Promise.all([
			writeFile(bundlePath, PACKAGE_BYTES),
			writeFile(provenancePath, PROVENANCE_BYTES),
		]);
		const bundlePlugin = vi.fn(async () => ({ tarballPath: bundlePath }));

		const prepared = await prepareReleaseFiles(
			{
				workspace,
				runnerTemp,
				pluginDirectory: ".",
				provenanceFile: provenancePath,
				repository: "example/gallery",
				workflowRef: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
				repositoryVisibility: "public",
			},
			{ bundlePlugin, ...validationDependencies },
		);

		expect(bundlePlugin).toHaveBeenCalledWith({
			dir: await realpath(workspace),
			outDir: ".emdash-release",
		});
		expect(prepared.packageSlug).toBe("gallery");
	});

	it("rejects private GitHub attestations and paths outside their trusted roots", async () => {
		const provenancePath = join(runnerTemp, "attestation.json");
		await writeFile(provenancePath, PROVENANCE_BYTES);
		await expect(
			prepareReleaseFiles({
				workspace,
				runnerTemp,
				bundleFile: "bundle.tar.gz",
				provenanceFile: provenancePath,
				repository: "example/gallery",
				workflowRef: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
				repositoryVisibility: "private",
			}),
		).rejects.toThrow("public GitHub repositories");

		await expect(
			prepareReleaseFiles({
				workspace,
				runnerTemp,
				bundleFile: join(root, "outside.tar.gz"),
				provenanceFile: provenancePath,
				repository: "example/gallery",
				workflowRef: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
				repositoryVisibility: "public",
			}),
		).rejects.toThrow("Bundle file could not be read");
	});
});
