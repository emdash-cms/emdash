import { describe, it, expect, vi } from "vitest";

import {
	RESPONSIVE_BREAKPOINTS,
	buildResponsiveImage,
	responsiveSizes,
	responsiveWidths,
	type GetImage,
} from "../../../src/media/responsive.js";

describe("responsiveWidths", () => {
	it("includes breakpoints up to 2x the rendered width", () => {
		// maxWidth 400 -> cap 800: 640, 750 qualify (<=800), 828 does not
		expect(responsiveWidths(400)).toEqual([400, 640, 750]);
	});

	it("always includes the rendered width and sorts ascending", () => {
		const widths = responsiveWidths(800);
		expect(widths).toContain(800);
		expect(widths.toSorted((a, b) => a - b)).toEqual(widths);
	});

	it("does not duplicate a width already present in the breakpoints", () => {
		const widths = responsiveWidths(640);
		expect(widths.filter((w) => w === 640)).toHaveLength(1);
	});

	it("caps at the largest breakpoint for very large widths", () => {
		const widths = responsiveWidths(4000);
		expect(widths).toEqual([...RESPONSIVE_BREAKPOINTS, 4000]);
	});
});

describe("responsiveSizes", () => {
	it("returns a width-aware sizes attribute when width is known", () => {
		expect(responsiveSizes(800)).toBe("(min-width: 800px) 800px, 100vw");
	});

	it("falls back to 100vw when width is unknown", () => {
		expect(responsiveSizes(undefined)).toBe("100vw");
	});
});

describe("buildResponsiveImage", () => {
	const ABS = "https://cdn.example.com/a.jpg";

	it("returns null without both dimensions (avoids inferSize fetch)", async () => {
		const getImage = vi.fn();
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800 })).toBeNull();
		expect(await buildResponsiveImage(getImage, { src: ABS, height: 600 })).toBeNull();
		expect(await buildResponsiveImage(getImage, { src: "", width: 800, height: 600 })).toBeNull();
		expect(getImage).not.toHaveBeenCalled();
	});

	it("returns null for relative URLs without calling getImage", async () => {
		const getImage = vi.fn();
		// Relative same-origin proxy/public URLs are never optimized by Astro's
		// image services; skip them rather than emit a no-op srcset.
		expect(
			await buildResponsiveImage(getImage, {
				src: "/_emdash/api/media/file/01ABC.jpg",
				width: 800,
				height: 600,
			}),
		).toBeNull();
		expect(getImage).not.toHaveBeenCalled();
	});

	it("delegates to getImage and maps the result for absolute authorized URLs", async () => {
		const getImage: GetImage = vi.fn(async (opts) => ({
			src: `/_image?href=${encodeURIComponent(opts.src)}&w=1200`,
			srcSet: { attribute: "/_image?href=a&w=640 640w, /_image?href=a&w=1200 1200w" },
		}));
		const result = await buildResponsiveImage(getImage, {
			src: ABS,
			width: 800,
			height: 600,
		});
		expect(result).toEqual({
			src: `/_image?href=${encodeURIComponent(ABS)}&w=1200`,
			srcset: "/_image?href=a&w=640 640w, /_image?href=a&w=1200 1200w",
			sizes: "(min-width: 800px) 800px, 100vw",
		});
		expect(getImage).toHaveBeenCalledWith({
			src: ABS,
			width: 800,
			height: 600,
			widths: responsiveWidths(800),
			sizes: "(min-width: 800px) 800px, 100vw",
		});
	});

	it("returns null when the service passes the URL through unchanged (unauthorized host)", async () => {
		// baseService.getURL returns options.src verbatim for unauthorized hosts.
		const getImage: GetImage = async (opts) => ({ src: opts.src });
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800, height: 600 })).toBeNull();
	});

	it("returns null when getImage throws (no service available)", async () => {
		const getImage: GetImage = async () => {
			throw new Error("no image service");
		};
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800, height: 600 })).toBeNull();
	});
});
