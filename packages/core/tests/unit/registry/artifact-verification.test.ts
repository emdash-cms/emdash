import { gzipSync } from "node:zlib";

import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	MAX_BUNDLE_FILE_BYTES,
	MAX_BUNDLE_TAR_ENTRY_COUNT,
	computeMultihash,
} from "@emdash-cms/registry-verification";
import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it } from "vitest";

import {
	enforcedAccessEqual,
	validateRegistryArtifactBundle,
	verifyChecksum,
} from "../../../src/api/handlers/registry.js";

const encoder = new TextEncoder();
const manifest = {
	id: "test-plugin",
	version: "1.0.0",
	capabilities: ["content:read"],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};

function file(name: string, body: string | Uint8Array): TarEntry {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function bundle(entries: TarEntry[]): Promise<Uint8Array> {
	return new Uint8Array(gzipSync(await packTar(entries)));
}

async function canonicalBundle(
	overrides: Partial<typeof manifest> = {},
	extraEntries: TarEntry[] = [],
): Promise<Uint8Array> {
	return bundle([
		file("manifest.json", JSON.stringify({ ...manifest, ...overrides })),
		file("backend.js", "export default {};"),
		...extraEntries,
	]);
}

describe("registry artifact verification", () => {
	it("accepts a valid canonical bundle", async () => {
		const result = await validateRegistryArtifactBundle(
			await canonicalBundle(),
			"test-plugin",
			"1.0.0",
			"install",
		);

		expect(result).toMatchObject({
			success: true,
			data: {
				manifest: { id: "test-plugin", version: "1.0.0" },
				backendCode: "export default {};",
			},
		});
	});

	it.each([
		[async () => encoder.encode("not a gzip archive"), "The plugin bundle is not valid gzip data."],
		[
			() =>
				bundle([
					file("../manifest.json", JSON.stringify(manifest)),
					file("backend.js", "export default {};"),
				]),
			"The plugin bundle contains an unsafe path.",
		],
		[
			() =>
				bundle([
					file("manifest.json", JSON.stringify(manifest)),
					file("backend.js", "export default {};"),
					{ header: { name: "link", size: 0, type: "symlink" } },
				]),
			"The plugin bundle contains an unsupported archive entry type.",
		],
	] as const)(
		"preserves install rejection for malformed and unsafe archives",
		async (makeBytes, message) => {
			const result = await validateRegistryArtifactBundle(
				await makeBytes(),
				"test-plugin",
				"1.0.0",
				"install",
			);
			expect(result).toEqual({ success: false, error: { code: "INVALID_BUNDLE", message } });
		},
	);

	it("enforces compressed, file-size, and archive-entry limits", async () => {
		const compressed = await validateRegistryArtifactBundle(
			new Uint8Array(MAX_BUNDLE_COMPRESSED_BYTES + 1),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(compressed).toMatchObject({
			success: false,
			error: { code: "INVALID_BUNDLE", message: expect.stringContaining("compressed") },
		});

		const oversizedEntry = await validateRegistryArtifactBundle(
			await canonicalBundle({}, [file("large.bin", new Uint8Array(MAX_BUNDLE_FILE_BYTES + 1))]),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(oversizedEntry).toMatchObject({
			success: false,
			error: { code: "INVALID_BUNDLE", message: expect.stringContaining("per-file") },
		});

		const directories: TarEntry[] = Array.from(
			{ length: MAX_BUNDLE_TAR_ENTRY_COUNT - 1 },
			(_, index) => ({ header: { name: `dir-${index}/`, size: 0, type: "directory" } }),
		);
		const tooManyEntries = await validateRegistryArtifactBundle(
			await canonicalBundle({}, directories),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(tooManyEntries).toMatchObject({
			success: false,
			error: { code: "INVALID_BUNDLE", message: expect.stringContaining("archive entries") },
		});
	});

	it.each([
		[[file("backend.js", "export default {};")], "The plugin bundle is missing manifest.json."],
		[
			[
				file("manifest.json", JSON.stringify(manifest)),
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "export default {};"),
			],
			"The plugin bundle contains duplicate or ambiguous paths.",
		],
		[
			[file("manifest.json", "{"), file("backend.js", "export default {};")],
			"The plugin bundle manifest is not valid JSON.",
		],
		[
			[file("manifest.json", JSON.stringify({ id: "test-plugin" })), file("backend.js", "x")],
			"The plugin bundle manifest failed schema validation.",
		],
	] satisfies [TarEntry[], string][])(
		"preserves manifest rejection: %s",
		async (entries, message) => {
			const result = await validateRegistryArtifactBundle(
				await bundle(entries),
				"test-plugin",
				"1.0.0",
				"install",
			);
			expect(result).toEqual({ success: false, error: { code: "INVALID_BUNDLE", message } });
		},
	);

	it("preserves install manifest identity and version errors", async () => {
		const identity = await validateRegistryArtifactBundle(
			await canonicalBundle({ id: "other-plugin" }),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(identity).toEqual({
			success: false,
			error: {
				code: "MANIFEST_ID_MISMATCH",
				message: "Bundle manifest id (other-plugin) does not match registry slug (test-plugin)",
			},
		});

		const version = await validateRegistryArtifactBundle(
			await canonicalBundle({ version: "2.0.0" }),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(version).toEqual({
			success: false,
			error: {
				code: "MANIFEST_VERSION_MISMATCH",
				message: "Bundle manifest version (2.0.0) does not match release version (1.0.0)",
			},
		});

		const both = await validateRegistryArtifactBundle(
			await canonicalBundle({ id: "other-plugin", version: "2.0.0" }),
			"test-plugin",
			"1.0.0",
			"install",
		);
		expect(both.error?.code).toBe("MANIFEST_VERSION_MISMATCH");
	});

	it("preserves update manifest identity and version errors", async () => {
		const identity = await validateRegistryArtifactBundle(
			await canonicalBundle({ id: "other-plugin" }),
			"test-plugin",
			"1.0.0",
			"update",
		);
		expect(identity.error?.code).toBe("BUNDLE_IDENTITY_MISMATCH");

		const version = await validateRegistryArtifactBundle(
			await canonicalBundle({ version: "2.0.0" }),
			"test-plugin",
			"1.0.0",
			"update",
		);
		expect(version.error?.code).toBe("BUNDLE_VERSION_MISMATCH");
	});

	it("preserves legacy hex and multihash checksum compatibility", async () => {
		const bytes = await canonicalBundle();
		const multihash = await computeMultihash(bytes);
		expect(multihash.success).toBe(true);
		if (!multihash.success) return;

		expect(await verifyChecksum(bytes, multihash.value)).toBe(true);
		expect(await verifyChecksum(bytes, `b${multihash.value.slice(1).toUpperCase()}`)).toBe(true);
		expect(await verifyChecksum(bytes, "0".repeat(64))).toBe(false);
	});

	it("preserves enforced access consistency semantics", () => {
		expect(
			enforcedAccessEqual(
				{ network: { request: { allowedHosts: ["a.example", "b.example"] } } },
				{ network: { request: { allowedHosts: ["b.example", "a.example"] } } },
			),
		).toBe(true);
		expect(
			enforcedAccessEqual(
				{ network: { request: { allowedHosts: ["a.example"] } } },
				{ network: { request: {} } },
			),
		).toBe(false);
	});
});
