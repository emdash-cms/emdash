/**
 * Inline editor image LQIP round-trip tests.
 *
 * Verifies blurhash/dominantColor survive the Portable Text ↔ ProseMirror
 * conversion the inline (visual-editing) editor exercises, so author-inserted
 * images keep their placeholders. LQIP is persisted as first-class block fields
 * (matching the image-field path); `asset.meta` is only a read fallback for
 * legacy snapshots.
 */

import { describe, it, expect } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

describe("Image LQIP round-trip (inline editor seam)", () => {
	it("preserves blurhash and dominantColor through PT → PM → PT (legacy asset.meta input)", () => {
		const imageBlock = {
			_type: "image",
			_key: "img001",
			asset: {
				_ref: "01ABC",
				url: "/_emdash/api/media/file/01ABC.jpg",
				meta: {
					blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
					dominantColor: "#aabbcc",
				},
			},
			alt: "A photo",
			width: 1200,
			height: 800,
		};

		const pm = portableTextToPM([imageBlock]);
		const node = pm.content?.[0] as {
			type: string;
			attrs?: { blurhash?: string; dominantColor?: string };
		};

		expect(node.type).toBe("image");
		expect(node.attrs?.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
		expect(node.attrs?.dominantColor).toBe("#aabbcc");

		const pt = pmToPortableText(pm);
		const restored = pt[0] as {
			_type: string;
			asset?: { meta?: Record<string, unknown> };
			blurhash?: string;
			dominantColor?: string;
		};

		// Promoted to first-class fields on save; asset.meta no longer carries them.
		expect(restored._type).toBe("image");
		expect(restored.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
		expect(restored.dominantColor).toBe("#aabbcc");
		expect(restored.asset?.meta?.blurhash).toBeUndefined();
		expect(restored.asset?.meta?.dominantColor).toBeUndefined();
	});

	it("preserves first-class LQIP through PT → PM → PT", () => {
		const imageBlock = {
			_type: "image",
			_key: "img001b",
			asset: { _ref: "01ABC2", url: "/_emdash/api/media/file/01ABC2.jpg" },
			alt: "A photo",
			width: 1200,
			height: 800,
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
		};

		const pm = portableTextToPM([imageBlock]);
		const node = pm.content?.[0] as {
			attrs?: { blurhash?: string; dominantColor?: string };
		};
		expect(node.attrs?.blurhash).toBe("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
		expect(node.attrs?.dominantColor).toBe("#112233");

		const pt = pmToPortableText(pm);
		const restored = pt[0] as {
			blurhash?: string;
			dominantColor?: string;
			asset?: { meta?: Record<string, unknown> };
		};
		expect(restored.blurhash).toBe("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
		expect(restored.dominantColor).toBe("#112233");
		expect(restored.asset?.meta?.blurhash).toBeUndefined();
	});

	it("omits LQIP entirely when none is present", () => {
		const imageBlock = {
			_type: "image",
			_key: "img002",
			asset: { _ref: "01XYZ", url: "/_emdash/api/media/file/01XYZ.jpg" },
			alt: "No placeholder",
			width: 640,
			height: 480,
		};

		const pm = portableTextToPM([imageBlock]);
		const node = pm.content?.[0] as {
			attrs?: { blurhash?: string | null; dominantColor?: string | null };
		};
		expect(node.attrs?.blurhash ?? null).toBeNull();
		expect(node.attrs?.dominantColor ?? null).toBeNull();

		const pt = pmToPortableText(pm);
		const restored = pt[0] as {
			asset?: { meta?: Record<string, unknown> };
			blurhash?: string;
			dominantColor?: string;
		};
		expect(restored.asset?.meta).toBeUndefined();
		expect(restored.blurhash).toBeUndefined();
		expect(restored.dominantColor).toBeUndefined();
	});
});
