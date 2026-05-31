import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ArtifactUploadError,
	resolveReleaseArtifacts,
	type ArtifactUploader,
} from "../src/publish/upload-artifacts.js";

const PNG_1x1 = Uint8Array.from(
	Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0a8a0000000049454e44ae426082",
		"hex",
	),
);

interface Uploaded {
	url: string;
	contentType: string;
	bytes: number;
}

function recordingUploader(): { uploader: ArtifactUploader; uploads: Uploaded[] } {
	const uploads: Uploaded[] = [];
	const uploader: ArtifactUploader = async ({ url, contentType, bytes }) => {
		uploads.push({ url, contentType, bytes: bytes.length });
	};
	return { uploader, uploads };
}

describe("resolveReleaseArtifacts", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-artifacts-"));
		await writeFile(join(dir, "icon.png"), PNG_1x1);
		await writeFile(join(dir, "banner.png"), PNG_1x1);
		await writeFile(join(dir, "s1.png"), PNG_1x1);
		await writeFile(join(dir, "s2.png"), PNG_1x1);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no artifacts are declared", async () => {
		const result = await resolveReleaseArtifacts({
			artifacts: undefined,
			manifestDir: dir,
			baseUrl: "https://cdn.example.com",
			slug: "gallery",
			version: "1.0.0",
			upload: recordingUploader().uploader,
		});
		expect(result).toBeUndefined();
	});

	it("uploads and records icon, banner, and a screenshot gallery", async () => {
		const { uploader, uploads } = recordingUploader();
		const result = await resolveReleaseArtifacts({
			artifacts: {
				icon: { file: "./icon.png" },
				banner: { file: "./banner.png" },
				screenshot: [{ file: "./s1.png" }, { file: "./s2.png", lang: "de" }],
			},
			manifestDir: dir,
			baseUrl: "https://cdn.example.com/",
			slug: "gallery",
			version: "1.0.0",
			upload: uploader,
		});

		expect(result?.icon).toMatchObject({
			url: "https://cdn.example.com/gallery/1.0.0/icon-icon.png",
			contentType: "image/png",
			width: 1,
			height: 1,
		});
		expect(result?.banner?.url).toBe("https://cdn.example.com/gallery/1.0.0/banner-banner.png");
		expect(result?.screenshots).toHaveLength(2);
		expect(result?.screenshots?.[0]?.url).toBe(
			"https://cdn.example.com/gallery/1.0.0/screenshot-1-s1.png",
		);
		expect(result?.screenshots?.[1]?.lang).toBe("de");

		// One PUT per artifact, with the measured content type.
		expect(uploads).toHaveLength(4);
		expect(uploads.every((u) => u.contentType === "image/png")).toBe(true);
	});

	it("preserves screenshot order", async () => {
		const { uploader } = recordingUploader();
		const result = await resolveReleaseArtifacts({
			artifacts: { screenshot: [{ file: "./s2.png" }, { file: "./s1.png" }] },
			manifestDir: dir,
			baseUrl: "https://cdn.example.com",
			slug: "gallery",
			version: "1.0.0",
			upload: uploader,
		});
		expect(result?.screenshots?.map((s) => s.url)).toEqual([
			"https://cdn.example.com/gallery/1.0.0/screenshot-1-s2.png",
			"https://cdn.example.com/gallery/1.0.0/screenshot-2-s1.png",
		]);
	});

	it("gives same-basename screenshots in different dirs distinct upload URLs", async () => {
		await mkdir(join(dir, "light"));
		await mkdir(join(dir, "dark"));
		await writeFile(join(dir, "light", "shot.png"), PNG_1x1);
		await writeFile(join(dir, "dark", "shot.png"), PNG_1x1);

		const { uploader, uploads } = recordingUploader();
		const result = await resolveReleaseArtifacts({
			artifacts: { screenshot: [{ file: "./light/shot.png" }, { file: "./dark/shot.png" }] },
			manifestDir: dir,
			baseUrl: "https://cdn.example.com",
			slug: "gallery",
			version: "1.0.0",
			upload: uploader,
		});

		const urls = result?.screenshots?.map((s) => s.url) ?? [];
		expect(urls).toEqual([
			"https://cdn.example.com/gallery/1.0.0/screenshot-1-shot.png",
			"https://cdn.example.com/gallery/1.0.0/screenshot-2-shot.png",
		]);
		expect(new Set(urls).size).toBe(2);
		expect(new Set(uploads.map((u) => u.url)).size).toBe(2);
	});

	it("gives an icon and a same-basename screenshot distinct upload URLs", async () => {
		await writeFile(join(dir, "image.png"), PNG_1x1);

		const result = await resolveReleaseArtifacts({
			artifacts: { icon: { file: "./image.png" }, screenshot: [{ file: "./image.png" }] },
			manifestDir: dir,
			baseUrl: "https://cdn.example.com",
			slug: "gallery",
			version: "1.0.0",
			upload: recordingUploader().uploader,
		});

		expect(result?.icon?.url).toBe("https://cdn.example.com/gallery/1.0.0/icon-image.png");
		expect(result?.screenshots?.[0]?.url).toBe(
			"https://cdn.example.com/gallery/1.0.0/screenshot-1-image.png",
		);
		expect(result?.icon?.url).not.toBe(result?.screenshots?.[0]?.url);
	});

	it("accepts a filename that begins with two dots", async () => {
		await writeFile(join(dir, "..config.png"), PNG_1x1);

		const result = await resolveReleaseArtifacts({
			artifacts: { icon: { file: "./..config.png" } },
			manifestDir: dir,
			baseUrl: "https://cdn.example.com",
			slug: "gallery",
			version: "1.0.0",
			upload: recordingUploader().uploader,
		});

		expect(result?.icon?.url).toBe("https://cdn.example.com/gallery/1.0.0/icon-..config.png");
	});

	it("rejects a file path that escapes the manifest directory", async () => {
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "../secret.png" } },
				manifestDir: dir,
				baseUrl: "https://cdn.example.com",
				slug: "gallery",
				version: "1.0.0",
				upload: recordingUploader().uploader,
			}),
		).rejects.toMatchObject({ name: "ArtifactUploadError", code: "ARTIFACT_PATH_ESCAPE" });
	});

	it("surfaces an unreadable file as a typed error", async () => {
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "./missing.png" } },
				manifestDir: dir,
				baseUrl: "https://cdn.example.com",
				slug: "gallery",
				version: "1.0.0",
				upload: recordingUploader().uploader,
			}),
		).rejects.toMatchObject({ name: "ArtifactUploadError", code: "ARTIFACT_FILE_UNREADABLE" });
	});

	it("surfaces an upload failure as a typed error", async () => {
		const failing: ArtifactUploader = async () => {
			throw new Error("503 from CDN");
		};
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "./icon.png" } },
				manifestDir: dir,
				baseUrl: "https://cdn.example.com",
				slug: "gallery",
				version: "1.0.0",
				upload: failing,
			}),
		).rejects.toBeInstanceOf(ArtifactUploadError);
	});

	it("rejects a non-image file", async () => {
		await writeFile(join(dir, "notimage.png"), new TextEncoder().encode("nope"));
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "./notimage.png" } },
				manifestDir: dir,
				baseUrl: "https://cdn.example.com",
				slug: "gallery",
				version: "1.0.0",
				upload: recordingUploader().uploader,
			}),
		).rejects.toBeInstanceOf(ArtifactUploadError);
	});
});
