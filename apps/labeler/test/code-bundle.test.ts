import { describe, expect, it } from "vitest";

import { createBlobCachePackageBundleReader } from "../src/code/assessment.js";
import { unpackPackageBundle, verifyPackageBytes } from "../src/code/bundle.js";
import {
	blobCidForChecksum,
	checksumOf,
	cleanBundleEntries,
	createBundle,
	createTar,
	gzip,
} from "./code-fixtures.js";

function codes(result: Awaited<ReturnType<typeof unpackPackageBundle>>) {
	return result.anomalies.map(({ code }) => code);
}

describe("package bundle intake", () => {
	it("unpacks a well-formed bundle without anomalies", async () => {
		const result = await unpackPackageBundle(
			await createBundle([{ name: "./", type: "5" }, ...cleanBundleEntries()]),
		);
		expect(result.anomalies).toEqual([]);
		expect(result.files.map(({ path }) => path)).toEqual([
			"manifest.json",
			"backend.js",
			"README.md",
		]);
		expect(result.files[1]?.text).toContain("export default");
	});

	it("reports symbolic and hard links without following them", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				...cleanBundleEntries(),
				{ name: "admin.js", type: "2" },
				{ name: "icon.png", type: "1" },
			]),
		);
		expect(codes(result)).toEqual(["symlink", "hardlink"]);
		expect(result.anomalies[0]).toMatchObject({ entryIndex: 3, name: "admin.js" });
		expect(result.files.map(({ path }) => path)).not.toContain("admin.js");
	});

	it("reports traversal, absolute and control-character paths", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				...cleanBundleEntries(),
				{ name: "../escape.js", content: "x" },
				{ name: "/etc/passwd", content: "x" },
				{ name: "bad\u0001name.js", content: "x" },
			]),
		);
		expect(codes(result)).toEqual(["path-traversal", "path-traversal", "unsafe-path"]);
		expect(result.files).toHaveLength(3);
	});

	it("reports duplicate and case-colliding entry names and scans both copies", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				...cleanBundleEntries("export const first = 1;"),
				{ name: "./backend.js", content: "export const second = 2;" },
				{ name: "README.MD", content: "shadow" },
			]),
		);
		expect(codes(result)).toEqual(["duplicate-entry", "duplicate-entry", "unexpected-entry"]);
		expect(result.files.filter(({ path }) => path === "backend.js")).toHaveLength(2);
	});

	it("reports entries outside the bundle layout, including npm-style package roots", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				{ name: "package/manifest.json", content: "{}" },
				{ name: "package/backend.js", content: "" },
				{ name: "screenshots/one.png", content: "png" },
				{ name: "lib/", type: "5" },
			]),
		);
		expect(codes(result)).toEqual([
			"unexpected-entry",
			"unexpected-entry",
			"unexpected-entry",
			"missing-required-entry",
			"missing-required-entry",
		]);
	});

	it("reports pax and other unsupported entry types", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				{ name: "PaxHeader", type: "x", content: "30 path=../../escape.js\n" },
				...cleanBundleEntries(),
				{ name: "fifo", type: "6" },
			]),
		);
		expect(codes(result)).toEqual(["unsupported-entry-type", "unsupported-entry-type"]);
	});

	it("applies the installer's rules for entry names and directories", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				...cleanBundleEntries(),
				{ name: "screenshots/", type: "5", content: "x" },
				{ name: "admin.js\0hidden", content: "x" },
				{ name: "screenshots", type: "5" },
				{ name: "icon.png/", content: "x" },
			]),
		);
		expect(codes(result)).toEqual([
			"malformed-archive",
			"unsafe-path",
			"unsafe-path",
			"unsafe-path",
		]);
		expect(result.files.map(({ path }) => path)).toEqual([
			"manifest.json",
			"backend.js",
			"README.md",
		]);
	});

	it("reports invalid gzip, truncated archives and oversized content", async () => {
		expect(codes(await unpackPackageBundle(new TextEncoder().encode("not gzip")))).toEqual([
			"invalid-gzip",
		]);
		const tar = createTar(cleanBundleEntries());
		expect(codes(await unpackPackageBundle(await gzip(tar.subarray(0, 1024))))).toContain(
			"malformed-archive",
		);
		const large = await unpackPackageBundle(
			await createBundle([
				...cleanBundleEntries(),
				{ name: "admin.js", content: "a".repeat(129 * 1024) },
			]),
		);
		expect(codes(large)).toEqual(["file-size-exceeded"]);
		const bomb = await unpackPackageBundle(await gzip(new Uint8Array(2 * 1024 * 1024)));
		expect(codes(bomb)).toContain("decompressed-size-exceeded");
	});

	it("reports text files that are not valid UTF-8", async () => {
		const result = await unpackPackageBundle(
			await createBundle([
				{ name: "manifest.json", content: "{}" },
				{ name: "backend.js", content: Uint8Array.of(0xff, 0xfe, 0x00) },
			]),
		);
		expect(codes(result)).toEqual(["invalid-text-encoding"]);
		expect(result.files[1]?.text).toBeUndefined();
	});

	it("verifies bytes against the signed checksum and blob reference", async () => {
		const bytes = await createBundle(cleanBundleEntries());
		const checksum = await checksumOf(bytes);
		await expect(
			verifyPackageBytes(bytes, { checksum, blobCid: blobCidForChecksum(checksum) }),
		).resolves.toBeUndefined();
		await expect(verifyPackageBytes(new Uint8Array([1]), { checksum })).rejects.toThrow(
			/checksum rejected/,
		);
		const other = await checksumOf(new Uint8Array([1]));
		await expect(
			verifyPackageBytes(bytes, { checksum, blobCid: blobCidForChecksum(other) }),
		).rejects.toThrow(/does not match its blob reference/);
	});

	it("never fetches a package that has only a publisher URL", async () => {
		const reader = createBlobCachePackageBundleReader({
			resolver: {
				async resolve() {
					throw new Error("resolver must not be called");
				},
			},
			transport: {
				async fetch() {
					throw new Error("transport must not be called");
				},
			},
		});
		await expect(
			reader.read(
				{
					uri: "at://did:plc:assessmentfixture00000000/com.emdashcms.experimental.package.release/gallery:1.2.3",
					cid: "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai",
					version: "1.2.3",
					packageSlug: "gallery",
					artifact: { checksum: "bafy" },
					declaredAccess: {},
				},
				1024,
			),
		).rejects.toThrow(/no blob reference/);
	});
});
