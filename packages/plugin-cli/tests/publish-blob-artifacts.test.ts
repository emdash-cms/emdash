import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Blob } from "@atcute/lexicons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArtifactUploadError, resolveReleaseArtifacts } from "../src/publish/blob-artifacts.js";

const PNG_1X1 = Uint8Array.from(
	Buffer.from(
		"89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bf0a8a0000000049454e44ae426082",
		"hex",
	),
);
const BLOB: Blob = {
	$type: "blob",
	ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
	mimeType: "image/png",
	size: PNG_1X1.byteLength,
};

describe("resolveReleaseArtifacts", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-artifacts-"));
		await Promise.all([
			writeFile(join(dir, "icon.png"), PNG_1X1),
			writeFile(join(dir, "banner.png"), PNG_1X1),
			writeFile(join(dir, "s1.png"), PNG_1X1),
			writeFile(join(dir, "s2.png"), PNG_1X1),
		]);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("uploads and records blob-only image artifacts in manifest order", async () => {
		const upload = vi.fn(async (): Promise<Blob> => BLOB);
		const result = await resolveReleaseArtifacts({
			artifacts: {
				icon: { file: "./icon.png" },
				banner: { file: "./banner.png" },
				screenshots: [{ file: "./s2.png" }, { file: "./s1.png", lang: "de" }],
			},
			manifestDir: dir,
			upload,
		});

		expect(upload).toHaveBeenCalledTimes(4);
		expect(upload).toHaveBeenCalledWith({
			bytes: expect.objectContaining({ byteLength: PNG_1X1.byteLength }),
			contentType: "image/png",
		});
		expect(result?.icon).toMatchObject({ blob: BLOB, width: 1, height: 1 });
		expect(result?.banner).toMatchObject({ blob: BLOB, width: 1, height: 1 });
		expect(result?.screenshots).toHaveLength(2);
		expect(result?.screenshots?.[1]?.lang).toBe("de");
		expect(result?.screenshots?.every((artifact) => artifact.url === undefined)).toBe(true);
	});

	it("returns undefined when no artifacts are declared", async () => {
		await expect(
			resolveReleaseArtifacts({ artifacts: undefined, manifestDir: dir, upload: vi.fn() }),
		).resolves.toBeUndefined();
	});

	it("accepts same-basename files because blobs are content-addressed", async () => {
		await mkdir(join(dir, "light"));
		await mkdir(join(dir, "dark"));
		await writeFile(join(dir, "light", "shot.png"), PNG_1X1);
		await writeFile(join(dir, "dark", "shot.png"), PNG_1X1);

		const result = await resolveReleaseArtifacts({
			artifacts: {
				screenshots: [{ file: "./light/shot.png" }, { file: "./dark/shot.png" }],
			},
			manifestDir: dir,
			upload: async () => BLOB,
		});

		expect(result?.screenshots?.map((artifact) => artifact.blob?.ref.$link)).toEqual([
			BLOB.ref.$link,
			BLOB.ref.$link,
		]);
	});

	it("rejects a file path that escapes the manifest directory", async () => {
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "../secret.png" } },
				manifestDir: dir,
				upload: async () => BLOB,
			}),
		).rejects.toMatchObject({ name: "ArtifactUploadError", code: "ARTIFACT_PATH_ESCAPE" });
	});

	it("rejects an uploaded blob CID that does not match the file", async () => {
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "./icon.png" } },
				manifestDir: dir,
				upload: async () => ({
					...BLOB,
					ref: { $link: "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q" },
				}),
			}),
		).rejects.toMatchObject({
			name: "ArtifactUploadError",
			code: "ARTIFACT_CHECKSUM_MISMATCH",
		});
	});

	it("surfaces upload failures as typed errors", async () => {
		await expect(
			resolveReleaseArtifacts({
				artifacts: { icon: { file: "./icon.png" } },
				manifestDir: dir,
				upload: async () => {
					throw new Error("PDS unavailable");
				},
			}),
		).rejects.toBeInstanceOf(ArtifactUploadError);
	});
});
