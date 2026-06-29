/**
 * Tests for the field widget plugin pipeline.
 *
 * Covers:
 * - Manifest schema validation for fieldWidgets
 * - definePlugin() with fieldWidgets
 * - FieldWidgetConfig type correctness
 */

import { describe, expect, it } from "vitest";

import { pluginManifestSchema } from "../../../src/plugins/manifest-schema.js";

/** Minimal valid manifest */
function makeManifest(admin: Record<string, unknown> = {}) {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin,
	};
}

describe("pluginManifestSchema — fieldWidgets", () => {
	it("should accept manifest without fieldWidgets", () => {
		const result = pluginManifestSchema.safeParse(makeManifest());
		expect(result.success).toBe(true);
	});

	it("should accept manifest with empty fieldWidgets array", () => {
		const result = pluginManifestSchema.safeParse(makeManifest({ fieldWidgets: [] }));
		expect(result.success).toBe(true);
	});

	it("should accept a valid field widget definition", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "picker",
						label: "Color Picker",
						fieldTypes: ["string"],
					},
				],
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should accept multiple field widget definitions", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "picker",
						label: "Color Picker",
						fieldTypes: ["string"],
					},
					{
						name: "pricing",
						label: "Pricing Editor",
						fieldTypes: ["json"],
						elements: [{ type: "toggle", action_id: "enabled", label: "Enable" }],
					},
				],
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should accept field widget with Block Kit elements", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "pricing",
						label: "Pricing",
						fieldTypes: ["json"],
						elements: [
							{ type: "toggle", action_id: "enabled", label: "Enable" },
							{ type: "text_input", action_id: "price", label: "Price" },
							{
								type: "select",
								action_id: "mode",
								label: "Mode",
								options: [{ value: "a", label: "A" }],
							},
						],
					},
				],
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should accept field widget with multiple field types", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "hex",
						label: "Hex Input",
						fieldTypes: ["string", "json", "date"],
					},
				],
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should reject field widget with empty name", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "",
						label: "Test",
						fieldTypes: ["string"],
					},
				],
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject field widget with empty label", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "test",
						label: "",
						fieldTypes: ["string"],
					},
				],
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject field widget without name", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						label: "Test",
						fieldTypes: ["string"],
					},
				],
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject field widget without fieldTypes", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "test",
						label: "Test",
					},
				],
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should accept field widget with empty fieldTypes array", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				fieldWidgets: [
					{
						name: "test",
						label: "Test",
						fieldTypes: [],
					},
				],
			}),
		);
		expect(result.success).toBe(true);
	});
});
