/**
 * Coverage for the manifest publisher field and its check/write-back.
 *
 * Two subjects:
 *   - The Zod schema's PublisherSchema (accepts DID or handle; rejects
 *     anything else).
 *   - `checkPublisher` and `writePublisherBack` in `manifest/publisher.ts`.
 *
 * The handle-resolution path is covered indirectly: we stub the resolver
 * by passing values that look like a DID directly, which bypasses
 * `@atcute/identity-resolver`. Real handle resolution requires DNS, which
 * we don't exercise in unit tests.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Did } from "@atcute/lexicons/syntax";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkPublisher, writePublisherBack } from "../src/manifest/publisher.js";
import { ManifestSchema, PublisherSchema } from "../src/manifest/schema.js";

const SESSION_DID = "did:plc:abc123def456" as Did;
const OTHER_DID = "did:plc:xyz789otherrr" as Did;

describe("PublisherSchema", () => {
	it("accepts a did:plc identifier", () => {
		expect(PublisherSchema.parse("did:plc:abc123")).toBe("did:plc:abc123");
	});

	it("accepts a did:web identifier", () => {
		expect(PublisherSchema.parse("did:web:example.com")).toBe("did:web:example.com");
	});

	it("accepts a handle", () => {
		expect(PublisherSchema.parse("example.com")).toBe("example.com");
		expect(PublisherSchema.parse("jane.bsky.social")).toBe("jane.bsky.social");
	});

	it("rejects a bare slug", () => {
		const result = PublisherSchema.safeParse("not-a-handle-or-did");
		expect(result.success).toBe(false);
	});

	it("rejects an empty string", () => {
		const result = PublisherSchema.safeParse("");
		expect(result.success).toBe(false);
	});

	it("rejects a malformed did", () => {
		// `did:` without method+id is not a valid DID.
		const result = PublisherSchema.safeParse("did:");
		expect(result.success).toBe(false);
	});
});

describe("ManifestSchema with publisher", () => {
	const minimal = {
		license: "MIT",
		author: { name: "Jane Doe" },
		security: { email: "security@example.com" },
	};

	it("accepts a manifest with a DID publisher", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			publisher: "did:plc:abc123",
		});
		expect(result.success).toBe(true);
	});

	it("accepts a manifest with a handle publisher", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			publisher: "example.com",
		});
		expect(result.success).toBe(true);
	});

	it("accepts a manifest without a publisher (first-publish state)", () => {
		const result = ManifestSchema.safeParse(minimal);
		expect(result.success).toBe(true);
	});

	it("rejects a manifest with an invalid publisher", () => {
		const result = ManifestSchema.safeParse({
			...minimal,
			publisher: "not-valid",
		});
		expect(result.success).toBe(false);
	});
});

describe("checkPublisher", () => {
	it("returns 'unpinned' when the manifest has no publisher", async () => {
		const result = await checkPublisher({
			manifestPublisher: undefined,
			sessionDid: SESSION_DID,
		});
		expect(result.kind).toBe("unpinned");
	});

	it("returns 'match' when a pinned DID equals the session DID", async () => {
		const result = await checkPublisher({
			manifestPublisher: SESSION_DID,
			sessionDid: SESSION_DID,
		});
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.pinnedDid).toBe(SESSION_DID);
		}
	});

	it("returns 'mismatch' when a pinned DID differs from the session DID", async () => {
		const result = await checkPublisher({
			manifestPublisher: OTHER_DID,
			sessionDid: SESSION_DID,
		});
		expect(result.kind).toBe("mismatch");
		if (result.kind === "mismatch") {
			expect(result.pinnedDid).toBe(OTHER_DID);
			expect(result.pinnedDisplay).toBe(OTHER_DID);
		}
	});

	// Handle resolution requires DNS / .well-known reachability. We test
	// the DID code path directly; the handle path is exercised in
	// integration tests separately (and against a mock resolver in
	// publisher-handle.test.ts when we add one later).
});

describe("writePublisherBack", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-publisher-test-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("inserts publisher after license, preserving comments and order", async () => {
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	// Top-level comment
	"license": "MIT",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		await writePublisherBack({ manifestPath: path, sessionDid: SESSION_DID });
		const updated = await readFile(path, "utf8");
		// The new key is present, the comment survives, and the DID is
		// written verbatim.
		expect(updated).toContain(`"publisher": "${SESSION_DID}"`);
		expect(updated).toContain("// Top-level comment");
		expect(updated).toContain('"license": "MIT"');
		// The publisher must land AFTER license. We test ordering by
		// finding the byte offset of each key.
		const licenseIdx = updated.indexOf('"license"');
		const publisherIdx = updated.indexOf('"publisher"');
		const authorIdx = updated.indexOf('"author"');
		expect(licenseIdx).toBeLessThan(publisherIdx);
		expect(publisherIdx).toBeLessThan(authorIdx);
	});

	it("appends a // <handle> comment when a session handle is provided", async () => {
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	"license": "MIT",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		await writePublisherBack({
			manifestPath: path,
			sessionDid: SESSION_DID,
			sessionHandle: "jane.bsky.social",
		});
		const updated = await readFile(path, "utf8");
		// The comment lives on the same line as the DID; the comma (if
		// any) is between the DID and the comment per JSONC convention.
		expect(updated).toMatch(/"publisher": "did:plc:abc123def456",? \/\/ jane\.bsky\.social/);
		// And the round-trip still parses cleanly (the comment doesn't
		// break JSONC).
		const { loadManifest } = await import("../src/manifest/load.js");
		const { manifest } = await loadManifest(path);
		expect(manifest.publisher).toBe(SESSION_DID);
	});

	it("anchors the comment to the publisher property even when the DID appears in another field", async () => {
		// Regression: a previous implementation searched for the DID
		// string anywhere in the document, which would attach the
		// `// <handle>` comment to whichever field happened to contain
		// the DID-shaped substring first. Real plugins that document a
		// "previous publisher was did:plc:..." in the description (e.g.
		// after a maintainer transfer) would have triggered this.
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	"license": "MIT",
	"description": "Originally published as ${SESSION_DID}. See changelog.",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		await writePublisherBack({
			manifestPath: path,
			sessionDid: SESSION_DID,
			sessionHandle: "jane.bsky.social",
		});
		const updated = await readFile(path, "utf8");
		// The handle comment lives on the publisher line, NOT on the
		// description line — confirm by inspecting each.
		const lines = updated.split("\n");
		const descriptionLine = lines.find((l) => l.includes('"description"'))!;
		const publisherLine = lines.find((l) => l.includes('"publisher"'))!;
		expect(descriptionLine).toBeDefined();
		expect(publisherLine).toBeDefined();
		expect(descriptionLine).not.toMatch(/\/\/ jane\.bsky\.social/);
		expect(publisherLine).toMatch(/\/\/ jane\.bsky\.social/);
	});

	it("omits the comment when no handle is provided", async () => {
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	"license": "MIT",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		await writePublisherBack({ manifestPath: path, sessionDid: SESSION_DID });
		const updated = await readFile(path, "utf8");
		// The DID line has no trailing `//` comment.
		const publisherLine = updated.split("\n").find((l) => l.includes('"publisher"'));
		expect(publisherLine).toBeDefined();
		expect(publisherLine).not.toContain("//");
	});

	it("preserves the source's indentation (2-space)", async () => {
		// Regression: an earlier version hard-coded tab indentation in
		// the modify() formattingOptions, which silently reformatted
		// any 2-space-indented manifest to tabs on first publish. The
		// detector sniffs the source's existing indent and matches it.
		const path = join(dir, "emdash-plugin.jsonc");
		const source = [
			"{",
			'  "slug": "my-plugin",',
			'  "version": "0.1.0",',
			'  "license": "MIT",',
			'  "author": { "name": "Jane Doe" },',
			'  "security": { "email": "security@example.com" }',
			"}",
			"",
		].join("\n");
		await writeFile(path, source, "utf8");
		await writePublisherBack({ manifestPath: path, sessionDid: SESSION_DID });
		const updated = await readFile(path, "utf8");
		// Pre-existing 2-space lines should still be 2-space, no tab
		// characters should have appeared anywhere.
		expect(updated).not.toContain("\t");
		// The new publisher line should also use 2 spaces.
		const publisherLine = updated.split("\n").find((l) => l.includes('"publisher"'))!;
		expect(publisherLine.startsWith("  ")).toBe(true);
		expect(publisherLine.startsWith("\t")).toBe(false);
	});

	it("does not overwrite an existing publisher (defensive re-parse)", async () => {
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	"license": "MIT",
	"publisher": "did:plc:user-pinned-already",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		let warnings = 0;
		let infos = 0;
		await writePublisherBack({
			manifestPath: path,
			sessionDid: SESSION_DID,
			onInfo: () => infos++,
			onWarn: () => warnings++,
		});
		const updated = await readFile(path, "utf8");
		// File unchanged: the existing publisher wins.
		expect(updated).toContain('"publisher": "did:plc:user-pinned-already"');
		expect(updated).not.toContain(SESSION_DID);
		expect(infos).toBe(1);
		expect(warnings).toBe(0);
	});

	it("does not fail when the file is missing (warns only)", async () => {
		const path = join(dir, "no-such-file.jsonc");
		let warnings = 0;
		await writePublisherBack({
			manifestPath: path,
			sessionDid: SESSION_DID,
			onWarn: () => warnings++,
		});
		// The publish has already succeeded by the time write-back runs;
		// a missing file at this point is surprising but never fatal.
		expect(warnings).toBe(1);
	});

	it("does not fail when the file no longer parses (warns only)", async () => {
		const path = join(dir, "broken.jsonc");
		// User broke the file while we were publishing.
		await writeFile(path, '{ "license": "MIT", broken syntax', "utf8");
		let warnings = 0;
		await writePublisherBack({
			manifestPath: path,
			sessionDid: SESSION_DID,
			onWarn: () => warnings++,
		});
		expect(warnings).toBe(1);
	});

	it("produces a JSONC document that round-trips through the loader", async () => {
		const path = join(dir, "emdash-plugin.jsonc");
		const source = `{
	"license": "MIT",
	"author": { "name": "Jane Doe" },
	"security": { "email": "security@example.com" }
}
`;
		await writeFile(path, source, "utf8");
		await writePublisherBack({ manifestPath: path, sessionDid: SESSION_DID });

		// Re-load through the actual loader. If write-back produced
		// malformed JSONC or a value the schema rejects, this throws.
		const { loadManifest } = await import("../src/manifest/load.js");
		const { manifest } = await loadManifest(path);
		expect(manifest.publisher).toBe(SESSION_DID);
		expect(manifest.license).toBe("MIT");
		expect(manifest.author?.name).toBe("Jane Doe");
	});
});
