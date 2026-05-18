/**
 * Manifest assertions for the AT Protocol plugin.
 *
 * The redesigned sandboxed-plugin layout puts identity, trust contract,
 * and admin surface in `emdash-plugin.jsonc` (the source of truth) and
 * leaves `src/plugin.ts` for runtime code only. This test snapshots the
 * manifest's structural shape so a refactor can't silently change the
 * published trust contract or admin surface.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { version } from "../package.json";

const MANIFEST_PATH = fileURLToPath(new URL("../emdash-plugin.jsonc", import.meta.url));

interface Manifest {
	slug: string;
	version: string;
	publisher: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<string, { indexes: string[] }>;
	admin: {
		pages: Array<{ path: string; label: string; icon?: string }>;
		widgets: Array<{ id: string; title?: string; size?: string }>;
	};
}

async function loadManifest(): Promise<Manifest> {
	const source = await readFile(MANIFEST_PATH, "utf8");
	const errors: import("jsonc-parser").ParseError[] = [];
	const value: unknown = parseJsonc(source, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		throw new Error(`Manifest parse failed: ${JSON.stringify(errors)}`);
	}
	return value as Manifest;
}

describe("atproto plugin manifest", () => {
	it("declares the expected identity", async () => {
		const manifest = await loadManifest();
		expect(manifest.slug).toBe("atproto");
		expect(manifest.version).toBe(version);
	});

	it("declares the required capabilities", async () => {
		const manifest = await loadManifest();
		expect(manifest.capabilities).toContain("content:read");
		expect(manifest.capabilities).toContain("network:request:unrestricted");
	});

	it("declares the storage used by the runtime", async () => {
		const manifest = await loadManifest();
		expect(manifest.storage).toHaveProperty("records");
		expect(manifest.storage.records.indexes).toContain("contentId");
		expect(manifest.storage.records.indexes).toContain("status");
		expect(manifest.storage.records.indexes).toContain("lastSyncedAt");
	});

	it("declares the admin pages and widgets", async () => {
		const manifest = await loadManifest();
		expect(manifest.admin.pages).toHaveLength(1);
		expect(manifest.admin.pages[0]?.path).toBe("/status");
		expect(manifest.admin.widgets).toHaveLength(1);
		expect(manifest.admin.widgets[0]?.id).toBe("sync-status");
	});
});
