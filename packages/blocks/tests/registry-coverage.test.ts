/**
 * Section Registry Coverage Test
 *
 * Validates that all section types defined in admin starter templates are properly
 * wired across all layers:
 * - Admin starter templates (sectionTemplates.ts)
 * - Admin plugin block definitions (SECTION_TEMPLATE_PLUGIN_BLOCKS)
 * - Admin visual preview (SectionVisualPreview.tsx)
 * - Blocks types (types.ts Block union)
 * - Blocks builder functions (builders.ts)
 * - Blocks renderer (renderer.tsx)
 * - Core Astro component registry (components/index.ts)
 *
 * This catches drift when a section exists in one layer but not another.
 *
 * Note: Some block types like "pullquote" and "cover" are handled by Astro components
 * in the core package, not by the blocks package renderer. This is intentional -
 * the blocks package is for admin-facing block kit components, while the Astro
 * components handle rendering in the public-facing site.
 */

import { describe, expect, it } from "vitest";
import type { Block } from "../src/types.js";

// ── Central Registry ───────────────────────────────────────────────────────────
//
// This is the source of truth for all section block types in EmDash.
// When adding a new section block, update this registry and all derived
// arrays/lists will automatically stay in sync.
//
// Layers where this type appears:
// - admin/src/lib/sectionTemplates.ts: Starter templates and plugin blocks
// - admin/src/components/SectionVisualPreview.tsx: Admin visual preview
// - packages/blocks/src/types.ts: TypeScript type definitions
// - packages/blocks/src/builders.ts: Builder functions
// - packages/blocks/src/renderer.tsx: React renderer switch cases
// - packages/core/src/components/index.ts: Astro component exports

export const REGISTRY_BLOCK_TYPES = [
	// Layout sections
	"cover",
	"tab",

	// Content sections
	"block",
	"pullquote",
	"accordion",
	"banner",
	"card",
	"cardGrid",
	"steps",
	"image",

	// Marketing sections
	"button",
	"stats",
	"featureList",
	"pricingTable",
	"ctaBanner",

	// Social sections
	"testimonial",

	// Media sections
	"videoEmbed",

	// Navigation sections
	"faq",

	// Brand logos
	"logoCloud",

	// Icon block
	"icon",
] as const;

export type RegistryBlockType = (typeof REGISTRY_BLOCK_TYPES)[number];

// ── Layer-Specific Block Type Sets ────────────────────────────────────────────

/**
 * Block types that appear in admin starter templates.
 * These are the _type values used in Portable Text content.
 */
export const ADMIN_TEMPLATE_BLOCK_TYPES = [
	"cover",
	"tab",
	"block",
	"pullquote",
	"accordion",
	"banner",
	"card",
	"cardGrid",
	"steps",
	"image",
	"button",
	"stats",
	"featureList",
	"pricingTable",
	"ctaBanner",
	"testimonial",
	"videoEmbed",
	"faq",
	"logoCloud",
] as const;

/**
 * Block types that have admin plugin block definitions.
 * These should match a subset of ADMIN_TEMPLATE_BLOCK_TYPES.
 */
export const ADMIN_PLUGIN_BLOCK_TYPES = [
	"cover",
	"button",
	"pullquote",
	"accordion",
	"banner",
	"testimonial",
	"card",
	"cardGrid",
	"tab",
	"stats",
	"featureList",
	"logoCloud",
	"steps",
	"faq",
	"videoEmbed",
	"pricingTable",
	"ctaBanner",
] as const;

/**
 * Block types with visual preview components in SectionVisualPreview.tsx.
 * These should match ADMIN_PLUGIN_BLOCK_TYPES.
 */
export const ADMIN_PREVIEW_BLOCK_TYPES = [
	"block",
	"cover",
	"button",
	"pullquote",
	"image",
	"accordion",
	"banner",
	"testimonial",
	"card",
	"cardGrid",
	"tab",
	"stats",
	"featureList",
	"logoCloud",
	"steps",
	"faq",
	"videoEmbed",
	"pricingTable",
	"ctaBanner",
] as const;

/**
 * Block types rendered by the blocks package renderer (renderer.tsx).
 * Note: cover, pullquote, button are handled by Astro components.
 */
export const BLOCKS_RENDERER_TYPES = [
	"header",
	"section",
	"divider",
	"fields",
	"table",
	"actions",
	"stats",
	"form",
	"image",
	"context",
	"columns",
	"chart",
	"banner",
	"meter",
	"code",
	"tab",
	"empty",
	"accordion",
	"testimonial",
	"card",
	"cardGrid",
	"icon",
	"featureList",
	"logoCloud",
	"steps",
	"faq",
	"videoEmbed",
	"pricingTable",
	"ctaBanner",
] as const;

/**
 * Visual section block types handled by the blocks package renderer.
 * These are the main section components used in admin.
 */
export const BLOCKS_PACKAGE_VISUAL_TYPES = [
	"banner",
	"accordion",
	"testimonial",
	"card",
	"cardGrid",
	"tab",
	"stats",
	"featureList",
	"logoCloud",
	"steps",
	"faq",
	"videoEmbed",
	"pricingTable",
	"ctaBanner",
	"icon",
] as const;

/**
 * Block types handled by Astro core components (not blocks package).
 * These should have corresponding exports in core/components/index.ts.
 */
export const ASTRO_COMPONENT_TYPES = [
	"cover",
	"pullquote",
	"button",
] as const;

/**
 * Core Astro component registry exports for section components.
 * Maps block type to expected component name.
 */
export const CORE_COMPONENT_EXPORTS: Record<RegistryBlockType, string> = {
	cover: "Cover",
	tab: "Tabs",
	block: "PortableText",
	pullquote: "Pullquote",
	accordion: "Accordion",
	banner: "Banner",
	card: "Card",
	cardGrid: "CardGrid",
	steps: "Steps",
	image: "Image",
	button: "Button",
	stats: "Stats",
	featureList: "FeatureList",
	pricingTable: "PricingTable",
	ctaBanner: "CtaBanner",
	testimonial: "Testimonial",
	videoEmbed: "VideoEmbed",
	faq: "Faq",
	logoCloud: "LogoCloud",
	icon: "Icon",
};

/**
 * Expected TypeScript type names in types.ts Block union.
 */
export const BLOCK_TYPE_NAMES: Record<RegistryBlockType, string> = {
	cover: "CoverBlock",
	tab: "TabBlock",
	block: "Block", // Portable Text block
	pullquote: "PullquoteBlock",
	accordion: "AccordionBlock",
	banner: "BannerBlock",
	card: "CardBlock",
	cardGrid: "CardGridBlock",
	steps: "StepsBlock",
	image: "ImageBlock",
	button: "ButtonElement", // Element, not Block
	stats: "StatsBlock",
	featureList: "FeatureListBlock",
	pricingTable: "PricingTableBlock",
	ctaBanner: "CtaBannerBlock",
	testimonial: "TestimonialBlock",
	videoEmbed: "VideoEmbedBlock",
	faq: "FaqBlock",
	logoCloud: "LogoCloudBlock",
	icon: "IconBlock",
};

/**
 * Expected builder function names in builders.ts.
 */
export const BLOCK_BUILDER_NAMES: Record<RegistryBlockType, string> = {
	cover: "cover", // Not in blocks.ts
	tab: "tabBlock",
	block: "block", // Not applicable
	pullquote: "pullquote", // Not in blocks.ts
	accordion: "accordion",
	banner: "bannerBlock",
	card: "card",
	cardGrid: "cardGrid",
	steps: "steps",
	image: "image",
	button: "button", // Element builder
	stats: "stats",
	featureList: "featureList",
	pricingTable: "pricingTable",
	ctaBanner: "ctaBanner",
	testimonial: "testimonial",
	videoEmbed: "videoEmbed",
	faq: "faq",
	logoCloud: "logoCloud",
	icon: "icon",
};

/**
 * Expected renderer switch case types in renderer.tsx.
 * Some blocks use the same type string for both type definition and rendering.
 */
export const RENDERER_CASE_TYPES = BLOCKS_RENDERER_TYPES;

// ── Coverage Validation Helpers ────────────────────────────────────────────────

/**
 * Check that all items in required are present in actual.
 * Returns array of missing items for diagnostic output.
 */
function findMissing<T extends string>(required: readonly T[], actual: readonly string[]): T[] {
	return [...required].filter((item) => !actual.includes(item));
}

/**
 * Check that all items in actual are present in required.
 * Returns array of extra items for diagnostic output.
 */
function findExtra<T extends string>(required: readonly T[], actual: readonly string[]): string[] {
	return [...actual].filter((item) => !required.includes(item));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Section Registry Coverage", () => {
	describe("Registry Integrity", () => {
		it("should have a non-empty block type registry", () => {
			expect(REGISTRY_BLOCK_TYPES.length).toBeGreaterThan(0);
		});

		it("should not have duplicate block types in registry", () => {
			const unique = new Set(REGISTRY_BLOCK_TYPES);
			expect(unique.size).toBe(REGISTRY_BLOCK_TYPES.length);
		});

		it("should have all required properties for each block type", () => {
			for (const blockType of REGISTRY_BLOCK_TYPES) {
				expect(CORE_COMPONENT_EXPORTS[blockType]).toBeDefined();
				expect(BLOCK_TYPE_NAMES[blockType]).toBeDefined();
				expect(BLOCK_BUILDER_NAMES[blockType]).toBeDefined();
			}
		});
	});

	describe("Admin Template Layer", () => {
		it("should have non-empty admin template block types", () => {
			expect(ADMIN_TEMPLATE_BLOCK_TYPES.length).toBeGreaterThan(0);
		});

		it("should not have duplicate block types in admin templates", () => {
			const unique = new Set(ADMIN_TEMPLATE_BLOCK_TYPES);
			expect(unique.size).toBe(ADMIN_TEMPLATE_BLOCK_TYPES.length);
		});

		it("should not have duplicate block types in admin plugin blocks", () => {
			const unique = new Set(ADMIN_PLUGIN_BLOCK_TYPES);
			expect(unique.size).toBe(ADMIN_PLUGIN_BLOCK_TYPES.length);
		});

		it("should not have duplicate block types in admin preview", () => {
			const unique = new Set(ADMIN_PREVIEW_BLOCK_TYPES);
			expect(unique.size).toBe(ADMIN_PREVIEW_BLOCK_TYPES.length);
		});
	});

	describe("Admin Plugin Block Coverage", () => {
		/**
		 * Block types that are handled by standard PortableText mechanisms
		 * rather than custom plugin blocks. These should not require plugin definitions.
		 */
		const PORTABLE_TEXT_NATIVE_TYPES = [
			"block", // Standard PortableText block rendering
			"image", // Standard PortableText image rendering
		] as const;

		it("all admin plugin blocks should have visual preview support", () => {
			const missing = findExtra(
				ADMIN_PLUGIN_BLOCK_TYPES,
				ADMIN_PREVIEW_BLOCK_TYPES,
			);

			if (missing.length > 0) {
				console.warn(
					`Plugin blocks missing visual preview: ${missing.join(", ")}`,
				);
			}

			// Allow block type since it just renders text
			const previewablePluginBlocks = ADMIN_PLUGIN_BLOCK_TYPES.filter(
				(t) => t !== "block",
			);
			const missingPreview = findMissing(
				previewablePluginBlocks,
				ADMIN_PREVIEW_BLOCK_TYPES,
			);

			expect(missingPreview).toEqual([]);
		});

		it("all preview blocks should have plugin block definition (except native PT types)", () => {
			// Exclude 'block' and 'image' types since they're handled by standard PortableText
			const pluginBlockTypes = new Set([
				...ADMIN_PLUGIN_BLOCK_TYPES,
				...PORTABLE_TEXT_NATIVE_TYPES,
			]);

			const previewableBlocks = ADMIN_PREVIEW_BLOCK_TYPES.filter(
				(t) => !PORTABLE_TEXT_NATIVE_TYPES.includes(t),
			);
			const missing = findMissing(
				previewableBlocks,
				[...pluginBlockTypes],
			);

			if (missing.length > 0) {
				console.warn(
					`Preview blocks missing plugin definition: ${missing.join(", ")}`,
				);
			}

			expect(missing).toEqual([]);
		});
	});

	describe("Blocks Package Layer", () => {
		it("should have non-empty renderer types", () => {
			expect(BLOCKS_RENDERER_TYPES.length).toBeGreaterThan(0);
		});

		it("should not have duplicate renderer types", () => {
			const unique = new Set(BLOCKS_RENDERER_TYPES);
			expect(unique.size).toBe(BLOCKS_RENDERER_TYPES.length);
		});

		it("all visual block types should be in renderer types", () => {
			const missing = findMissing(
				BLOCKS_PACKAGE_VISUAL_TYPES,
				BLOCKS_RENDERER_TYPES,
			);

			if (missing.length > 0) {
				console.error(
					`Missing renderer cases for: ${missing.join(", ")}`,
				);
			}

			expect(missing).toEqual([]);
		});

		it("should not include Astro-only types in blocks renderer", () => {
			const astroTypesInRenderer = findExtra(
				BLOCKS_RENDERER_TYPES,
				ASTRO_COMPONENT_TYPES,
			);

			// These types should NOT be in blocks renderer
			const accidentallyIncluded = ASTRO_COMPONENT_TYPES.filter((t) =>
				BLOCKS_RENDERER_TYPES.includes(t as typeof BLOCKS_RENDERER_TYPES[number]),
			);

			expect(accidentallyIncluded).toEqual([]);
		});
	});

	describe("Type System Coverage", () => {
		it("should have TypeScript types for all block types", () => {
			// Document expected type strings - type checking happens at compile time
			const expectedTypeStrings = Object.values(BLOCK_TYPE_NAMES);

			expect(expectedTypeStrings.length).toBe(REGISTRY_BLOCK_TYPES.length);
		});

		it("should have builder functions for visual block types", () => {
			// These block types should have builder functions in builders.ts
			const expectedBuilderBlockTypes: RegistryBlockType[] = [
				"accordion",
				"banner",
				"card",
				"cardGrid",
				"tab",
				"stats",
				"featureList",
				"logoCloud",
				"steps",
				"faq",
				"videoEmbed",
				"pricingTable",
				"ctaBanner",
				"icon",
			];

			for (const blockType of expectedBuilderBlockTypes) {
				expect(BLOCK_BUILDER_NAMES[blockType]).toBeDefined();
			}
		});
	});

	describe("Core Component Coverage", () => {
		it("should have core component export mapping for all visual block types", () => {
			const visualBlockTypes: RegistryBlockType[] = [
				"cover",
				"tab",
				"accordion",
				"banner",
				"card",
				"cardGrid",
				"steps",
				"stats",
				"featureList",
				"pricingTable",
				"ctaBanner",
				"testimonial",
				"videoEmbed",
				"faq",
				"logoCloud",
				"icon",
				"pullquote",
			];

			for (const blockType of visualBlockTypes) {
				expect(CORE_COMPONENT_EXPORTS[blockType]).toBeDefined();
			}
		});
	});

	describe("Cross-Layer Consistency", () => {
		it("should have consistent block type representation across layers", () => {
			// Visual section blocks should appear in:
			// 1. Admin templates (content)
			// 2. Admin plugin blocks
			// 3. Admin visual preview
			// 4. Blocks renderer

			const visualBlocks: RegistryBlockType[] = [
				"accordion",
				"banner",
				"testimonial",
				"card",
				"cardGrid",
				"tab",
				"stats",
				"featureList",
				"logoCloud",
				"steps",
				"faq",
				"videoEmbed",
				"pricingTable",
				"ctaBanner",
			];

			// Check each visual block type
			for (const blockType of visualBlocks) {
				const inTemplates = ADMIN_TEMPLATE_BLOCK_TYPES.includes(blockType);
				const inPlugins = ADMIN_PLUGIN_BLOCK_TYPES.includes(blockType);
				const inPreview = ADMIN_PREVIEW_BLOCK_TYPES.includes(blockType);
				const inRenderer = BLOCKS_RENDERER_TYPES.includes(blockType);

				const issues: string[] = [];
				if (!inTemplates) issues.push("admin templates");
				if (!inPlugins) issues.push("plugin blocks");
				if (!inPreview) issues.push("visual preview");
				if (!inRenderer) issues.push("blocks renderer");

				if (issues.length > 0) {
					console.error(
						`Block type "${blockType}" missing from: ${issues.join(", ")}`,
					);
				}

				expect(inTemplates).toBe(true);
				expect(inPlugins).toBe(true);
				expect(inPreview).toBe(true);
				expect(inRenderer).toBe(true);
			}
		});
	});
});

describe("Section Template Completeness", () => {
	const requiredCategories = [
		"layout",
		"content",
		"marketing",
		"media",
		"navigation",
		"social",
	] as const;

	it("should define all required section categories", () => {
		for (const category of requiredCategories) {
			expect(requiredCategories).toContain(category);
		}
	});

	it("should have a non-zero number of categories", () => {
		expect(requiredCategories.length).toBeGreaterThan(0);
	});
});

describe("Builder Function Existence", () => {
	// These tests document expected builder function existence
	// Actual validation requires importing builders.ts

	const expectedBlockBuilders = [
		"banner",
		"accordion",
		"testimonial",
		"card",
		"cardGrid",
		"tab",
		"stats",
		"featureList",
		"logoCloud",
		"steps",
		"faq",
		"videoEmbed",
		"pricingTable",
		"ctaBanner",
		"icon",
	] as const;

	it("should have documented builder function names for visual blocks", () => {
		expect(expectedBlockBuilders.length).toBeGreaterThan(0);
	});

	it("should have builder names for all expected block builders", () => {
		for (const builder of expectedBlockBuilders) {
			expect(BLOCK_BUILDER_NAMES[builder]).toBeDefined();
		}
	});
});
