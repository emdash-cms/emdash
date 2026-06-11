/**
 * Repro for issue #1404 follow-up: a downstream report claimed emdash <Image>
 * "renders empty when re-invoked from a component override".
 *
 * src in Image.astro is resolved entirely via buildRenderMediaUrl(node), so we
 * test a WordPress-migrated node three ways to see whether/when src is empty.
 */
import { describe, expect, test } from "vitest";

import { buildRenderMediaUrl } from "../../src/media/url.js";

// A WordPress-migrated Portable Text image node. The _ref is a bare ULID that
// differs from the storage-key ULID embedded in asset.url.
const realNode = {
	_type: "image",
	_key: "img66",
	asset: {
		_ref: "01KTRTJ5QSVC3TB57387DX445P",
		url: "/_emdash/api/media/file/01KTRTJ55S65SADEH9P9TSY89H.png",
	},
	alt: "",
	align: "right",
	displayWidth: 136,
	displayHeight: 201,
};

// Mirror of Image.astro src resolution for a local (no-provider) node.
function resolveSrc(node: any, getPublicMediaUrl: ((k: string) => string) | undefined) {
	const { asset } = node;
	let src = "";
	const providerId = asset.provider;
	if (providerId && providerId !== "local") {
		/* external branch, n/a for migrated */
	}
	if (!src) src = buildRenderMediaUrl(getPublicMediaUrl, { url: asset.url, id: asset._ref });
	return src;
}

const localResolver = (key: string) => `/_emdash/api/media/file/${key}`;

describe("Image.astro src resolution for migrated nodes", () => {
	test("in-pipeline (locals.emdash.getPublicMediaUrl present) -> non-empty", () => {
		const src = resolveSrc(realNode, localResolver);
		console.log("[in-pipeline]  src =", JSON.stringify(src));
		expect(src).not.toBe("");
	});

	test("override-style (resolver/locals absent) -> STILL non-empty (refutes empty-on-override theory)", () => {
		const src = resolveSrc(realNode, undefined);
		console.log("[no-resolver]  src =", JSON.stringify(src));
		expect(src).not.toBe("");
	});

	test("HYPOTHESIS: override gets node with asset.url stripped -> bare _ref fallback", () => {
		const stripped = { ...realNode, asset: { _ref: realNode.asset._ref } };
		const src = resolveSrc(stripped, localResolver);
		console.log("[url-stripped] src =", JSON.stringify(src));
		// extensionless, and a DIFFERENT ULID than the stored blob -> likely broken
		expect(src).toBe("/_emdash/api/media/file/01KTRTJ5QSVC3TB57387DX445P");
	});
});
