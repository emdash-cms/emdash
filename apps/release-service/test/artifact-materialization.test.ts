import { safeParse } from "@atcute/lexicons";
import type { Blob } from "@atcute/lexicons/interfaces";
import { PackageRelease } from "@emdash-cms/registry-lexicons";
import { computeMultihash } from "@emdash-cms/registry-verification";
import { describe, expect, it, vi } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import {
	ArtifactMaterializationError,
	buildMaterializedRelease,
	materializeReleaseArtifacts,
	stageReleaseArtifacts,
	uploadStagedArtifact,
	type ArtifactUploadReceipt,
	type ReleaseArtifactMaterializationPlan,
} from "../src/publishing/materialize.js";

function writeUint24LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32BigEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
}

function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	writeUint32BigEndian(bytes, 8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	writeUint32BigEndian(bytes, 16, width);
	writeUint32BigEndian(bytes, 20, height);
	bytes.set([8, 6, 0, 0, 0], 24);
	return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(23);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
	bytes[7] = (height >>> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (width >>> 8) & 0xff;
	bytes[10] = width & 0xff;
	bytes[11] = 3;
	bytes.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 12);
	bytes.set([0xff, 0xd9], 21);
	return bytes;
}

function webpBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
	bytes.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12);
	writeUint24LittleEndian(bytes, 24, width - 1);
	writeUint24LittleEndian(bytes, 27, height - 1);
	return bytes;
}

const PACKAGE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
const PNG_BYTES = pngBytes(128, 128);
const JPEG_BYTES = jpegBytes(1200, 400);
const WEBP_BYTES = webpBytes(1440, 900);
const MOBILE_PNG_BYTES = pngBytes(390, 844);
const PUBLIC_ADDRESS = ["203.0.113.10"];

interface ArtifactSource {
	bytes: Uint8Array;
	contentType?: string;
	contentLength?: number;
}

function encodeBase32(bytes: Uint8Array): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let result = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += alphabet[(buffer >>> (bits - 5)) & 31] ?? "";
			bits -= 5;
		}
	}
	if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31] ?? "";
	return result;
}

async function rawCid(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
	const cid = new Uint8Array(4 + digest.byteLength);
	cid.set([0x01, 0x55, 0x12, 0x20]);
	cid.set(digest, 4);
	return `b${encodeBase32(cid)}`;
}

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error("Test checksum could not be computed");
	return result.value;
}

async function blobFor(bytes: Uint8Array, mimeType: string): Promise<Blob> {
	return {
		$type: "blob",
		ref: { $link: await rawCid(bytes) },
		mimeType,
		size: bytes.byteLength,
	};
}

async function completeRelease(): Promise<PackageRelease.Main> {
	const release = structuredClone(releaseFixture) as PackageRelease.Main;
	release.repo = "https://github.com/example/gallery";
	release.requires = { "env:emdash": ">=0.12.0" };
	release.provides = { blocks: ["gallery"] };
	release.artifacts = {
		package: {
			url: "https://assets.example/gallery.tgz",
			checksum: await checksum(PACKAGE_BYTES),
			contentType: "application/gzip",
			releaseAsset: true,
			requiresAuth: false,
			signature: "package-signature",
		},
		icon: {
			url: "https://assets.example/icon.png",
			checksum: await checksum(PNG_BYTES),
			contentType: "image/png",
			id: "primary-icon",
			width: 128,
			height: 128,
		},
		banner: {
			url: "https://assets.example/banner.jpg",
			checksum: await checksum(JPEG_BYTES),
			contentType: "image/jpeg",
			width: 1200,
			height: 400,
		},
		screenshots: [
			{
				url: "https://assets.example/screenshot.webp",
				checksum: await checksum(WEBP_BYTES),
				contentType: "image/webp",
				id: "desktop",
				lang: "en",
				width: 1440,
				height: 900,
			},
			{
				url: "https://assets.example/screenshot.png",
				checksum: await checksum(MOBILE_PNG_BYTES),
				contentType: "image/png",
				id: "mobile",
				width: 390,
				height: 844,
			},
		],
	};
	return release;
}

function sourceMap(entries: Record<string, ArtifactSource>) {
	return vi.fn(async (url: URL, init: RequestInit) => {
		const source = entries[url.pathname];
		if (!source) return new Response(null, { status: 404 });
		const headers = new Headers();
		if (source.contentType) headers.set("content-type", source.contentType);
		if (source.contentLength !== undefined) {
			headers.set("content-length", String(source.contentLength));
		}
		if (url.pathname === "/gallery.tgz") {
			expect(new Headers(init.headers).get("accept")).toBe("application/octet-stream");
		}
		return new Response(new Uint8Array(source.bytes), { headers });
	});
}

function allSources() {
	return sourceMap({
		"/gallery.tgz": { bytes: PACKAGE_BYTES, contentType: "application/octet-stream" },
		"/icon.png": { bytes: PNG_BYTES, contentType: "image/png" },
		"/banner.jpg": { bytes: JPEG_BYTES, contentType: "image/jpeg" },
		"/screenshot.webp": { bytes: WEBP_BYTES, contentType: "image/webp" },
		"/screenshot.png": { bytes: MOBILE_PNG_BYTES, contentType: "image/png" },
	});
}

function resolveHostname(): Promise<readonly string[]> {
	return Promise.resolve(PUBLIC_ADDRESS);
}

function persisted<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("release artifact materialization", () => {
	it("materializes a private staged source without network fetch", async () => {
		const release = structuredClone(releaseFixture) as PackageRelease.Main;
		release.artifacts.package.url =
			"https://release.example.com/v1/staged-artifacts/package/checksum";
		release.artifacts.package.checksum = await checksum(PACKAGE_BYTES);
		const fetch = vi.fn();
		const loadSource = vi.fn(async () => ({
			bytes: PACKAGE_BYTES,
			contentType: "application/gzip",
		}));

		const staged = await stageReleaseArtifacts(release, {
			fetch,
			resolveHostname,
			loadSource,
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(loadSource).toHaveBeenCalledWith({
			path: "package",
			url: release.artifacts.package.url,
			checksum: release.artifacts.package.checksum,
		});
		expect(staged.artifacts[0]).toMatchObject({
			metadata: { path: "package", mimeType: "application/gzip", size: PACKAGE_BYTES.byteLength },
			bytes: PACKAGE_BYTES,
		});
	});

	it("materializes package, icon, banner, and ordered screenshots into strict blobs", async () => {
		const release = await completeRelease();
		const original = structuredClone(release);
		const fetch = allSources();
		const uploads: Array<{ bytes: Uint8Array; mimeType: string }> = [];
		const uploadBlob = vi.fn(async (bytes: Uint8Array, mimeType: string) => {
			uploads.push({ bytes: new Uint8Array(bytes), mimeType });
			return blobFor(bytes, mimeType);
		});

		const staged = await stageReleaseArtifacts(release, {
			fetch,
			resolveHostname,
		});
		const receipts: ArtifactUploadReceipt[] = [];
		for (const artifact of staged.artifacts) {
			receipts.push(await uploadStagedArtifact(artifact, uploadBlob));
		}
		const persistedPlan: ReleaseArtifactMaterializationPlan = persisted(staged.plan);
		const persistedReceipts: ArtifactUploadReceipt[] = persisted(receipts);
		const materialized = buildMaterializedRelease(persistedPlan, persistedReceipts);

		expect(release).toEqual(original);
		expect(JSON.stringify(persistedPlan)).not.toContain("https://assets.example");
		expect(JSON.stringify(persistedPlan)).not.toContain('"bytes"');
		expect(staged.artifacts.map(({ metadata }) => metadata.path)).toEqual([
			"package",
			"icon",
			"banner",
			"screenshots[0]",
			"screenshots[1]",
		]);
		expect(
			staged.plan.artifacts.map(({ path, width, height }) => ({ path, width, height })),
		).toEqual([
			{ path: "package", width: undefined, height: undefined },
			{ path: "icon", width: 128, height: 128 },
			{ path: "banner", width: 1200, height: 400 },
			{ path: "screenshots[0]", width: 1440, height: 900 },
			{ path: "screenshots[1]", width: 390, height: 844 },
		]);
		expect(safeParse(PackageRelease.mainSchema, materialized, { strict: true }).ok).toBe(true);
		expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual([
			"/gallery.tgz",
			"/icon.png",
			"/banner.jpg",
			"/screenshot.webp",
			"/screenshot.png",
		]);
		expect(uploads.map((upload) => upload.mimeType)).toEqual([
			"application/gzip",
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/png",
		]);
		expect(materialized).toMatchObject({
			package: release.package,
			version: release.version,
			repo: release.repo,
			requires: release.requires,
			provides: release.provides,
			extensions: release.extensions,
			artifacts: {
				package: {
					blob: { $type: "blob", mimeType: "application/gzip", size: PACKAGE_BYTES.byteLength },
					checksum: release.artifacts.package.checksum,
					contentType: "application/gzip",
					signature: "package-signature",
				},
				icon: {
					blob: { mimeType: "image/png", size: PNG_BYTES.byteLength },
					id: "primary-icon",
					width: 128,
					height: 128,
				},
				banner: {
					blob: { mimeType: "image/jpeg", size: JPEG_BYTES.byteLength },
					width: 1200,
					height: 400,
				},
				screenshots: [
					{
						blob: { mimeType: "image/webp", size: WEBP_BYTES.byteLength },
						id: "desktop",
						lang: "en",
						width: 1440,
						height: 900,
					},
					{
						blob: { mimeType: "image/png", size: MOBILE_PNG_BYTES.byteLength },
						id: "mobile",
						width: 390,
						height: 844,
					},
				],
			},
		});
		for (const artifact of [
			materialized.artifacts.package,
			materialized.artifacts.icon,
			materialized.artifacts.banner,
			...(materialized.artifacts.screenshots ?? []),
		]) {
			expect(artifact).not.toHaveProperty("url");
			expect(artifact).not.toHaveProperty("requiresAuth");
			expect(artifact).not.toHaveProperty("releaseAsset");
		}
		expect(() => buildMaterializedRelease(persistedPlan, persistedReceipts.toReversed())).toThrow(
			expect.objectContaining({ code: "ARTIFACT_RECEIPTS_INVALID" }),
		);
		const tamperedDimensions = persisted(persistedPlan);
		if (!tamperedDimensions.artifacts[1]) throw new Error("Expected icon metadata");
		tamperedDimensions.artifacts[1].width = 127;
		expect(() => buildMaterializedRelease(tamperedDimensions, persistedReceipts)).toThrow(
			expect.objectContaining({ code: "ARTIFACT_RECEIPTS_INVALID", artifact: "icon" }),
		);
	});

	it.each([
		["unsafe host", "HOST_REJECTED"],
		["checksum mismatch", "CHECKSUM_MISMATCH"],
		["package size", "RESOURCE_SIZE_EXCEEDED"],
		["package MIME", "ARTIFACT_MIME_INVALID"],
		["unsupported auth", "AUTH_METHOD_UNSUPPORTED"],
	] as const)("fails closed for %s", async (scenario, code) => {
		const release = await completeRelease();
		const fetch = allSources();
		if (scenario === "unsafe host") {
			release.artifacts.package.url = "https://127.0.0.1/gallery.tgz";
		}
		if (scenario === "checksum mismatch") {
			release.artifacts.package.checksum = await checksum(PNG_BYTES);
		}
		if (scenario === "package size") {
			fetch.mockImplementationOnce(
				async () =>
					new Response(PACKAGE_BYTES, {
						headers: { "content-length": String(262_145) },
					}),
			);
		}
		if (scenario === "package MIME") {
			release.artifacts.package.checksum = await checksum(PNG_BYTES);
			fetch.mockImplementationOnce(async () => new Response(PNG_BYTES));
		}
		if (scenario === "unsupported auth") {
			release.artifacts.package.requiresAuth = true;
		}
		const uploadBlob = vi.fn();

		await expect(
			materializeReleaseArtifacts(release, { fetch, resolveHostname, uploadBlob }),
		).rejects.toMatchObject({ code, artifact: "package" });
		expect(uploadBlob).not.toHaveBeenCalled();
	});

	it("uses measured dimensions when the submitted image omits them", async () => {
		const release = await completeRelease();
		if (!release.artifacts.icon) throw new Error("Expected icon fixture");
		delete release.artifacts.package.contentType;
		delete release.artifacts.icon.contentType;
		delete release.artifacts.icon.width;
		delete release.artifacts.icon.height;

		const staged = await stageReleaseArtifacts(release, {
			fetch: allSources(),
			resolveHostname,
		});

		expect(staged.plan.release.artifacts.package).toMatchObject({
			contentType: "application/gzip",
		});
		expect(staged.plan.release.artifacts.icon).toMatchObject({
			contentType: "image/png",
			width: 128,
			height: 128,
		});
		expect(staged.plan.artifacts[1]).toMatchObject({
			path: "icon",
			width: 128,
			height: 128,
		});
	});

	it("rejects submitted dimensions that do not match the image bytes", async () => {
		const release = await completeRelease();
		if (!release.artifacts.icon) throw new Error("Expected icon fixture");
		release.artifacts.icon.width = 129;

		await expect(
			stageReleaseArtifacts(release, { fetch: allSources(), resolveHostname }),
		).rejects.toMatchObject({
			code: "ARTIFACT_DIMENSIONS_INVALID",
			artifact: "icon",
		});
	});

	it("rejects measured dimensions over the image limit", async () => {
		const release = await completeRelease();
		if (!release.artifacts.icon) throw new Error("Expected icon fixture");
		const oversized = pngBytes(8193, 1);
		release.artifacts.icon.checksum = await checksum(oversized);
		delete release.artifacts.icon.width;
		delete release.artifacts.icon.height;
		const fetch = allSources();
		fetch.mockImplementationOnce(async () => new Response(PACKAGE_BYTES));
		fetch.mockImplementationOnce(
			async () => new Response(oversized, { headers: { "content-type": "image/png" } }),
		);

		await expect(stageReleaseArtifacts(release, { fetch, resolveHostname })).rejects.toMatchObject({
			code: "ARTIFACT_DIMENSIONS_INVALID",
			artifact: "icon",
		});
	});

	it.each([
		["CID", async () => blobFor(PNG_BYTES, "application/gzip")],
		["MIME", async () => blobFor(PACKAGE_BYTES, "image/png")],
		["size", async () => ({ ...(await blobFor(PACKAGE_BYTES, "application/gzip")), size: 999 })],
	] as const)("rejects an uploaded blob with mismatched %s", async (_field, returnedBlob) => {
		const release = await completeRelease();
		await expect(
			materializeReleaseArtifacts(release, {
				fetch: allSources(),
				resolveHostname,
				uploadBlob: returnedBlob,
			}),
		).rejects.toMatchObject({
			code: "ARTIFACT_BLOB_INVALID",
			artifact: "package",
		});
	});

	it("rejects blob-only inputs because their bytes cannot be verified in this boundary", async () => {
		const release = await completeRelease();
		release.artifacts.package = {
			blob: await blobFor(PACKAGE_BYTES, "application/gzip"),
			checksum: await checksum(PACKAGE_BYTES),
			contentType: "application/gzip",
		};
		const fetch = vi.fn();
		const uploadBlob = vi.fn();

		await expect(
			materializeReleaseArtifacts(release, { fetch, resolveHostname, uploadBlob }),
		).rejects.toBeInstanceOf(ArtifactMaterializationError);
		await expect(
			materializeReleaseArtifacts(release, { fetch, resolveHostname, uploadBlob }),
		).rejects.toMatchObject({
			code: "ARTIFACT_SOURCE_UNVERIFIABLE",
			artifact: "package",
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(uploadBlob).not.toHaveBeenCalled();
	});

	it("retries deterministically after an uploader fails partway through", async () => {
		const release = await completeRelease();
		const uploadedMimeTypes: string[] = [];
		let failed = false;
		const uploadBlob = vi.fn(async (bytes: Uint8Array, mimeType: string) => {
			uploadedMimeTypes.push(mimeType);
			if (!failed && mimeType === "image/jpeg") {
				failed = true;
				throw new Error("provider detail that must not escape");
			}
			return blobFor(bytes, mimeType);
		});

		await expect(
			materializeReleaseArtifacts(release, {
				fetch: allSources(),
				resolveHostname,
				uploadBlob,
			}),
		).rejects.toMatchObject({
			code: "ARTIFACT_UPLOAD_FAILED",
			message: "ARTIFACT_UPLOAD_FAILED",
			artifact: "banner",
		});
		const retried = await materializeReleaseArtifacts(release, {
			fetch: allSources(),
			resolveHostname,
			uploadBlob,
		});
		const expected = await materializeReleaseArtifacts(release, {
			fetch: allSources(),
			resolveHostname,
			uploadBlob: blobFor,
		});

		expect(retried).toEqual(expected);
		expect(uploadedMimeTypes).toEqual([
			"application/gzip",
			"image/png",
			"image/jpeg",
			"application/gzip",
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/png",
		]);
	});

	it("re-materializes a mixed URL and blob descriptor from its verified URL bytes", async () => {
		const release = await completeRelease();
		const previousBlob = await blobFor(PACKAGE_BYTES, "application/gzip");
		release.artifacts.package.blob = previousBlob;
		const uploaded = await blobFor(PACKAGE_BYTES, "application/gzip");
		const uploadBlob = vi.fn(async (bytes: Uint8Array, mimeType: string) =>
			mimeType === "application/gzip" ? uploaded : blobFor(bytes, mimeType),
		);

		const result = await materializeReleaseArtifacts(release, {
			fetch: allSources(),
			resolveHostname,
			uploadBlob,
		});

		expect(uploadBlob).toHaveBeenCalled();
		expect(result.artifacts.package.blob).toEqual(uploaded);
		expect(result.artifacts.package).not.toHaveProperty("url");
	});

	it("applies the image descriptor limit before uploading any artifacts", async () => {
		const release = await completeRelease();
		const fetch = allSources();
		fetch.mockImplementationOnce(async () => new Response(PACKAGE_BYTES));
		fetch.mockImplementationOnce(
			async () =>
				new Response(PNG_BYTES, {
					headers: { "content-length": String(1_048_577) },
				}),
		);
		const uploadBlob = vi.fn();

		await expect(
			materializeReleaseArtifacts(release, { fetch, resolveHostname, uploadBlob }),
		).rejects.toMatchObject({ code: "RESOURCE_SIZE_EXCEEDED", artifact: "icon" });
		expect(uploadBlob).not.toHaveBeenCalled();
	});
});
