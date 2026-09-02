import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { computeMultihash, decodeMultihash } from "@emdash-cms/registry-verification/checksum";
import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it } from "vitest";

import { validateRegistryArtifact } from "../../../src/registry/artifact-verification.js";

const encoder = new TextEncoder();

function file(name: string, body: string | Uint8Array): TarEntry {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function createBundle(
	manifest: Record<string, unknown>,
	backend: string | Uint8Array = "export default {};",
): Promise<Uint8Array> {
	return new Uint8Array(
		gzipSync(
			await packTar([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", backend),
				file("admin.js", "export default {};"),
			]),
		),
	);
}

function pluginManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
		...overrides,
	};
}

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error(result.error.message);
	return result.value;
}

describe("validateRegistryArtifact", () => {
	it("returns a runtime bundle after shared checksum, archive, and manifest validation", async () => {
		const bytes = await createBundle(pluginManifest());
		const expectedChecksum = await checksum(bytes);
		const result = await validateRegistryArtifact(bytes, expectedChecksum, "test-plugin", "1.0.0");

		expect(result).toMatchObject({
			success: true,
			value: {
				bundle: {
					manifest: { id: "test-plugin", version: "1.0.0" },
					backendCode: "export default {};",
					adminCode: "export default {};",
				},
				artifactDigest: expect.any(Uint8Array),
			},
		});
		const decoded = decodeMultihash(expectedChecksum);
		if (!decoded.success || !result.success) throw new Error("expected valid checksum and bundle");
		expect(result.value.artifactDigest).toEqual(decoded.value.digest);
	});

	it("rejects legacy bare-hex checksums at the installer boundary", async () => {
		const bytes = await createBundle(pluginManifest());
		const hex = createHash("sha256").update(bytes).digest("hex");

		await expect(
			validateRegistryArtifact(bytes, hex, "test-plugin", "1.0.0"),
		).resolves.toMatchObject({
			success: false,
			error: { code: "INVALID_MULTIHASH" },
		});
	});

	it.each([
		["other-plugin", "1.0.0", "BUNDLE_ID_MISMATCH"],
		["test-plugin", "2.0.0", "BUNDLE_VERSION_MISMATCH"],
	] as const)("rejects package substitution for %s@%s", async (slug, version, code) => {
		const bytes = await createBundle(pluginManifest());

		await expect(
			validateRegistryArtifact(bytes, await checksum(bytes), slug, version),
		).resolves.toMatchObject({ success: false, error: { code } });
	});

	it("rejects unsupported manifest hooks through the shared report", async () => {
		const bytes = await createBundle(pluginManifest({ hooks: ["future:hook"] }));

		await expect(
			validateRegistryArtifact(bytes, await checksum(bytes), "test-plugin", "1.0.0"),
		).resolves.toMatchObject({
			success: false,
			error: { code: "BUNDLE_INVALID_MANIFEST" },
		});
	});

	it("rejects plugin code that is not valid UTF-8", async () => {
		const bytes = await createBundle(pluginManifest(), new Uint8Array([0xff]));

		await expect(
			validateRegistryArtifact(bytes, await checksum(bytes), "test-plugin", "1.0.0"),
		).resolves.toMatchObject({
			success: false,
			error: { code: "BUNDLE_INVALID_CODE_ENCODING" },
		});
	});
});
