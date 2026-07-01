/**
 * Admin editor image LQIP round-trip.
 *
 * blurhash/dominantColor must survive Portable Text ↔ ProseMirror conversion so
 * author-inserted images keep their placeholders. LQIP is persisted as
 * first-class block fields (matching the image-field path); `asset.meta` is
 * only a read fallback for legacy snapshots.
 */

import { describe, it, expect } from "vitest";

import {
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
} from "../../src/components/PortableTextEditor";

type ImagePMNode = { type: string; attrs?: Record<string, unknown> };
type ImagePTBlock = {
	_type: string;
	asset?: { meta?: { blurhash?: string; dominantColor?: string } };
	blurhash?: string;
	dominantColor?: string;
};

describe("admin editor image LQIP round-trip", () => {
	it("preserves blurhash and dominantColor through PT → PM → PT (promotes legacy asset.meta)", () => {
		const block = {
			_type: "image" as const,
			_key: "img1",
			asset: {
				_ref: "01ABC",
				url: "/_emdash/api/media/file/01ABC.jpg",
				meta: { blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj", dominantColor: "#aabbcc" },
			},
			alt: "A photo",
			width: 1200,
			height: 800,
		};

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
		const pm = portableTextToProsemirror([block as never]);
		const node = pm.content?.[0] as ImagePMNode;
		expect(node.type).toBe("image");
		expect(node.attrs?.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
		expect(node.attrs?.dominantColor).toBe("#aabbcc");

		const pt = prosemirrorToPortableText({ type: "doc", content: pm.content });
		const restored = pt[0] as ImagePTBlock;
		expect(restored._type).toBe("image");
		// Promoted to first-class fields; asset.meta no longer carries them.
		expect(restored.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
		expect(restored.dominantColor).toBe("#aabbcc");
		expect(restored.asset?.meta?.blurhash).toBeUndefined();
		expect(restored.asset?.meta?.dominantColor).toBeUndefined();
	});

	it("preserves first-class LQIP through PT → PM → PT", () => {
		const block = {
			_type: "image" as const,
			_key: "img1b",
			asset: { _ref: "01AB2", url: "/_emdash/api/media/file/01AB2.jpg" },
			alt: "A photo",
			width: 1200,
			height: 800,
			blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4",
			dominantColor: "#112233",
		};

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture
		const pm = portableTextToProsemirror([block as never]);
		const node = pm.content?.[0] as ImagePMNode;
		expect(node.attrs?.blurhash).toBe("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
		expect(node.attrs?.dominantColor).toBe("#112233");

		const pt = prosemirrorToPortableText({ type: "doc", content: pm.content });
		const restored = pt[0] as ImagePTBlock;
		expect(restored.blurhash).toBe("L6PZfSi_.AyE_3t7t7R**0o#DgR4");
		expect(restored.dominantColor).toBe("#112233");
		expect(restored.asset?.meta?.blurhash).toBeUndefined();
	});
});
