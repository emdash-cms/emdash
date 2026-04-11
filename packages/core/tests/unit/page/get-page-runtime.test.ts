/**
 * getPageRuntime() Tests
 *
 * Tests the gatekeeper function that Astro components (EmDashHead, EmDashBodyStart,
 * EmDashBodyEnd) use to access plugin page contribution methods from locals.
 *
 * Bug context: The middleware's anonymous fast-path returned early without
 * initializing the runtime, so locals.emdash was never populated for anonymous
 * visitors. getPageRuntime() returned undefined, and all plugin page hooks
 * (page:metadata, page:fragments) were silently skipped.
 *
 * Fix: The middleware now always initializes the runtime, so locals.emdash
 * includes collectPageMetadata and collectPageFragments for all requests.
 */

import { describe, it, expect, vi } from "vitest";

import { getPageRuntime } from "../../../src/page/index.js";

describe("getPageRuntime", () => {
	it("returns undefined when locals has no emdash property", () => {
		const locals: Record<string, unknown> = {};

		const result = getPageRuntime(locals);

		expect(result).toBeUndefined();
	});

	it("returns undefined when locals.emdash is null", () => {
		const locals: Record<string, unknown> = { emdash: null };

		const result = getPageRuntime(locals);

		expect(result).toBeUndefined();
	});

	it("returns undefined when locals.emdash is missing collectPageMetadata", () => {
		const locals: Record<string, unknown> = {
			emdash: {
				collectPageFragments: vi.fn(),
			},
		};

		const result = getPageRuntime(locals);

		expect(result).toBeUndefined();
	});

	it("returns undefined when locals.emdash is missing collectPageFragments", () => {
		const locals: Record<string, unknown> = {
			emdash: {
				collectPageMetadata: vi.fn(),
			},
		};

		const result = getPageRuntime(locals);

		expect(result).toBeUndefined();
	});

	it("returns the runtime when both page contribution methods are present", () => {
		const collectPageMetadata = vi.fn();
		const collectPageFragments = vi.fn();
		const locals: Record<string, unknown> = {
			emdash: {
				collectPageMetadata,
				collectPageFragments,
			},
		};

		const result = getPageRuntime(locals);

		expect(result).toBeDefined();
		expect(result!.collectPageMetadata).toBe(collectPageMetadata);
		expect(result!.collectPageFragments).toBe(collectPageFragments);
	});

	it("returns the runtime from a full middleware-shaped locals.emdash", () => {
		// Simulate the full shape that the middleware binds to locals.emdash,
		// verifying that the page contribution methods are extractable even
		// alongside all the other handler bindings.
		const collectPageMetadata = vi.fn();
		const collectPageFragments = vi.fn();
		const locals: Record<string, unknown> = {
			emdash: {
				handleContentList: vi.fn(),
				handleContentGet: vi.fn(),
				handleContentCreate: vi.fn(),
				handleContentUpdate: vi.fn(),
				handleContentDelete: vi.fn(),
				handleMediaList: vi.fn(),
				handlePluginApiRoute: vi.fn(),
				collectPageMetadata,
				collectPageFragments,
				storage: null,
				db: {},
				hooks: {},
				config: {},
			},
		};

		const result = getPageRuntime(locals);

		expect(result).toBeDefined();
		expect(result!.collectPageMetadata).toBe(collectPageMetadata);
		expect(result!.collectPageFragments).toBe(collectPageFragments);
	});
});
