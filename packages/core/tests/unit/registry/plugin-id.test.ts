/**
 * Tests for `makeRegistryPluginId`: collision resistance + determinism +
 * format. Backfills the coverage deferred from PR #1011 (the install
 * handler shipped without dedicated unit tests for the opaque-id helper).
 */

import { describe, expect, it } from "vitest";

import {
	isRegistryPluginId,
	makeRegistryPluginId,
	REGISTRY_PLUGIN_ID_PATTERN,
} from "../../../src/registry/plugin-id.js";

describe("makeRegistryPluginId", () => {
	it("produces an id that matches REGISTRY_PLUGIN_ID_PATTERN", async () => {
		const id = await makeRegistryPluginId("did:plc:abc123", "gallery");
		expect(REGISTRY_PLUGIN_ID_PATTERN.test(id)).toBe(true);
		expect(isRegistryPluginId(id)).toBe(true);
	});

	it("is deterministic — same (did, slug) always produces the same id", async () => {
		const a = await makeRegistryPluginId("did:plc:abc123", "gallery");
		const b = await makeRegistryPluginId("did:plc:abc123", "gallery");
		expect(a).toBe(b);
	});

	it("distinguishes different slugs under the same publisher", async () => {
		const gallery = await makeRegistryPluginId("did:plc:abc123", "gallery");
		const forms = await makeRegistryPluginId("did:plc:abc123", "forms");
		expect(gallery).not.toBe(forms);
	});

	it("distinguishes the same slug under different publishers", async () => {
		const acme = await makeRegistryPluginId("did:plc:acme0001", "forms");
		const corp = await makeRegistryPluginId("did:plc:corp0001", "forms");
		expect(acme).not.toBe(corp);
	});

	it("collision-resistant across 10 000 distinct (did, slug) pairs", async () => {
		// 80-bit ids — birthday collision is around 2^40 ≈ 10^12 inputs.
		// 10 000 inputs should give zero collisions with overwhelming
		// probability (~ 10^-12 chance per pair).
		const ids = await Promise.all(
			Array.from({ length: 10_000 }, (_, i) =>
				makeRegistryPluginId(`did:plc:test${i.toString(36).padStart(8, "0")}`, "x"),
			),
		);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
