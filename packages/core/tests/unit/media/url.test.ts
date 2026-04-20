import { describe, it, expect } from "vitest";

import { resolvePublicMediaUrl } from "../../../src/media/url.js";
import type { Storage } from "../../../src/storage/types.js";

function storageWith(publicUrl: string): Storage {
	return {
		upload: async () => ({ key: "", url: "", size: 0 }),
		download: async () => {
			throw new Error("not used");
		},
		delete: async () => {},
		exists: async () => true,
		list: async () => ({ files: [] }),
		getSignedUploadUrl: async () => {
			throw new Error("not used");
		},
		getPublicUrl: (key) => `${publicUrl}/${key}`,
	};
}

describe("resolvePublicMediaUrl", () => {
	it("returns an empty string when storageKey is empty", () => {
		expect(resolvePublicMediaUrl(null, "")).toBe("");
	});

	it("uses the proxied media endpoint when no storage is provided", () => {
		expect(resolvePublicMediaUrl(null, "01ABC.jpg")).toBe("/_emdash/api/media/file/01ABC.jpg");
	});

	it("uses storage.getPublicUrl when a storage adapter is provided", () => {
		const storage = storageWith("https://media.example.com");
		expect(resolvePublicMediaUrl(storage, "01ABC.jpg")).toBe("https://media.example.com/01ABC.jpg");
	});
});
