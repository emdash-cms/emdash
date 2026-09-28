import { expect, it } from "vitest";

import { mediaItemToGalleryImage } from "../../src/components/editor/GalleryDetailPanel.js";

it("copies a selected media focal point into the gallery snapshot", () => {
	const image = mediaItemToGalleryImage({
		id: "media-1",
		filename: "portrait.jpg",
		mimeType: "image/jpeg",
		url: "/_emdash/api/media/file/portrait.jpg",
		size: 1024,
		width: 1200,
		height: 800,
		focalX: 0.25,
		focalY: 0.75,
		createdAt: "2026-08-23T12:00:00.000Z",
	});

	expect(image).toMatchObject({ focalX: 0.25, focalY: 0.75 });
});
