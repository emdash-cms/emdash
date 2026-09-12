import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prepareRepositoryRelease } from "../src/release-prepare.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/minimal-plugin", import.meta.url));
const PUBLISHER_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";

describe("prepareRepositoryRelease", () => {
	let repositoryRoot: string;

	beforeEach(async () => {
		repositoryRoot = await mkdtemp(join(tmpdir(), "emdash-release-prepare-"));
		await cp(FIXTURE, join(repositoryRoot, "packages", "fixture-minimal"), { recursive: true });
	});

	afterEach(async () => {
		await rm(repositoryRoot, { recursive: true, force: true });
	});

	it("resolves a package tag to one nested plugin and bundles it", async () => {
		const release = await prepareRepositoryRelease({
			repositoryRoot,
			selector: "fixture-minimal@1.2.3",
			resolvePublisherDid: async () => PUBLISHER_DID,
		});

		expect(release).toMatchObject({
			packageSlug: "fixture-minimal",
			version: "1.2.3",
			pluginDirectory: "packages/fixture-minimal",
			publisherDid: PUBLISHER_DID,
		});
		expect(release.bundleFile).toBe(".emdash-release/fixture-minimal-1.2.3.tar.gz");
		await expect(readFile(join(repositoryRoot, release.bundleFile))).resolves.not.toHaveLength(0);
	});

	it("rejects a package tag whose version differs from the manifest", async () => {
		await expect(
			prepareRepositoryRelease({
				repositoryRoot,
				selector: "fixture-minimal@2.0.0",
				resolvePublisherDid: async () => PUBLISHER_DID,
			}),
		).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
	});

	it("rejects duplicate package IDs instead of selecting by traversal order", async () => {
		await cp(FIXTURE, join(repositoryRoot, "plugins", "duplicate"), { recursive: true });
		await expect(
			prepareRepositoryRelease({
				repositoryRoot,
				selector: "fixture-minimal",
				resolvePublisherDid: async () => PUBLISHER_DID,
			}),
		).rejects.toMatchObject({ code: "PACKAGE_AMBIGUOUS" });
	});

	it("ignores an unrelated incomplete plugin manifest", async () => {
		const incomplete = join(repositoryRoot, "packages", "incomplete");
		await mkdir(incomplete, { recursive: true });
		await writeFile(join(incomplete, "emdash-plugin.jsonc"), '{ "slug": ', "utf8");

		const release = await prepareRepositoryRelease({
			repositoryRoot,
			selector: "fixture-minimal",
			resolvePublisherDid: async () => PUBLISHER_DID,
		});

		expect(release.packageSlug).toBe("fixture-minimal");
	});

	it("does not follow symlinked directories during package discovery", async () => {
		await symlink(
			join(repositoryRoot, "packages", "fixture-minimal"),
			join(repositoryRoot, "linked"),
		);
		const release = await prepareRepositoryRelease({
			repositoryRoot,
			selector: "fixture-minimal",
			resolvePublisherDid: async () => PUBLISHER_DID,
		});
		expect(release.packageSlug).toBe("fixture-minimal");
	});
});
