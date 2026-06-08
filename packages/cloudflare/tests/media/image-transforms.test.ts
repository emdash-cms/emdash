import { describe, expect, it } from "vitest";

import {
	CLOUDFLARE_IMAGE_TRANSFORM_TYPES,
	cloudflareImageTransforms,
} from "../../src/media/image-transforms.js";

describe("cloudflareImageTransforms", () => {
	it("returns a media transform descriptor for the Cloudflare runtime", () => {
		const descriptor = cloudflareImageTransforms({
			binding: "IMAGES",
			timeoutMs: 5000,
			defaultWidth: 1200,
			maxWidth: 2000,
			quality: 80,
		});

		expect(descriptor).toEqual({
			entrypoint: "@emdash-cms/cloudflare/media/image-transforms",
			config: {
				binding: "IMAGES",
				timeoutMs: 5000,
				defaultWidth: 1200,
				maxWidth: 2000,
				quality: 80,
			},
			contentTypes: CLOUDFLARE_IMAGE_TRANSFORM_TYPES,
		});
	});
});
