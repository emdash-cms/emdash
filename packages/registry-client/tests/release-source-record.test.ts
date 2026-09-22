import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import releaseFixture from "../../registry-verification/fixtures/records/release.json";
import { parseDelegatedReleaseSourceRecord } from "../src/release-service/index.js";

const CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";

function sourceRecord(): PackageRelease.Main {
	const release = structuredClone(releaseFixture) as PackageRelease.Main;
	release.artifacts.package.checksum = CHECKSUM;
	release.artifacts.icon = {
		url: "https://example.com/icon.png",
		checksum: CHECKSUM,
		contentType: "image/png",
		width: 64,
		height: 64,
	};
	release.artifacts.banner = {
		url: "https://example.com/banner.webp",
		checksum: CHECKSUM,
		contentType: "image/webp",
		width: 1200,
		height: 400,
	};
	release.artifacts.screenshots = [
		{
			url: "https://example.com/screenshot.jpg",
			checksum: CHECKSUM,
			contentType: "image/jpeg",
			width: 800,
			height: 600,
		},
	];
	release.extensions = {
		[NSID.packageReleaseExtension]: {
			$type: NSID.packageReleaseExtension,
			declaredAccess: {},
			provenance: {
				url: "https://example.com/provenance.json",
				checksum: CHECKSUM,
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/example/gallery",
				builderId:
					"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
			},
		},
	};
	return release;
}

function blob() {
	return {
		$type: "blob" as const,
		ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
		mimeType: "application/gzip",
		size: 128,
	};
}

describe("delegated release source records", () => {
	it("accepts URL-only package and listing artifacts with required provenance", () => {
		const release = sourceRecord();

		expect(
			parseDelegatedReleaseSourceRecord(release, {
				packageSlug: "gallery",
				version: "1.2.3",
			}),
		).toEqual(release);
	});

	it.each([
		[
			"package blob",
			(release: PackageRelease.Main) => Object.assign(release.artifacts.package, { blob: blob() }),
		],
		[
			"image blob",
			(release: PackageRelease.Main) =>
				Object.assign(release.artifacts.icon!, {
					blob: { ...blob(), mimeType: "image/png" },
				}),
		],
		[
			"blob-only package",
			(release: PackageRelease.Main) => {
				delete release.artifacts.package.url;
				Object.assign(release.artifacts.package, { blob: blob() });
			},
		],
		[
			"blob-only image",
			(release: PackageRelease.Main) => {
				delete release.artifacts.icon!.url;
				Object.assign(release.artifacts.icon!, {
					blob: { ...blob(), mimeType: "image/png" },
				});
			},
		],
		["top-level auth", (release: PackageRelease.Main) => Object.assign(release, { auth: {} })],
		[
			"requiresAuth false",
			(release: PackageRelease.Main) =>
				Object.assign(release.artifacts.package, { requiresAuth: false }),
		],
		[
			"custom artifact slot",
			(release: PackageRelease.Main) =>
				Object.assign(release.artifacts, { "x-signature": { ...release.artifacts.package } }),
		],
		[
			"non-HTTPS package URL",
			(release: PackageRelease.Main) => {
				release.artifacts.package.url = "http://example.com/gallery.tgz";
			},
		],
		[
			"missing image URL",
			(release: PackageRelease.Main) => {
				delete release.artifacts.icon!.url;
			},
		],
		[
			"unsupported package MIME declaration",
			(release: PackageRelease.Main) => {
				release.artifacts.package.contentType = "application/zip";
			},
		],
		[
			"unsupported image MIME declaration",
			(release: PackageRelease.Main) => {
				release.artifacts.icon!.contentType = "image/svg+xml";
			},
		],
		[
			"non-canonical checksum",
			(release: PackageRelease.Main) => {
				release.artifacts.package.checksum = "bciqexample";
			},
		],
		[
			"missing provenance",
			(release: PackageRelease.Main) => {
				const extensions = release.extensions as Record<string, { provenance?: unknown }>;
				delete extensions[NSID.packageReleaseExtension]!.provenance;
			},
		],
		[
			"non-HTTPS provenance URL",
			(release: PackageRelease.Main) => {
				const extensions = release.extensions as Record<string, { provenance: { url: string } }>;
				extensions[NSID.packageReleaseExtension]!.provenance.url =
					"http://example.com/provenance.json";
			},
		],
		[
			"non-canonical provenance checksum",
			(release: PackageRelease.Main) => {
				const extensions = release.extensions as Record<
					string,
					{ provenance: { checksum: string } }
				>;
				extensions[NSID.packageReleaseExtension]!.provenance.checksum = "bciqexample";
			},
		],
	])("rejects %s", (_name, mutate) => {
		const release = sourceRecord();
		mutate(release);

		expect(parseDelegatedReleaseSourceRecord(release)).toBeNull();
	});

	it.each([
		["another-package", "1.2.3"],
		["gallery", "2.0.0"],
	])("rejects request envelope mismatch for %s at %s", (packageSlug, version) => {
		expect(
			parseDelegatedReleaseSourceRecord(sourceRecord(), {
				packageSlug,
				version,
			}),
		).toBeNull();
	});
});
