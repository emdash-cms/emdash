import { describe, it, expect } from "vitest";

import {
	buildRenderMediaUrl,
	createPublicMediaUrlResolver,
	resolvePublicMediaUrl,
	storageKeyFromLocalMediaFileUrl,
} from "../../../src/media/url.js";
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

describe("createPublicMediaUrlResolver", () => {
	it("returns a closure that reuses the storage adapter", () => {
		const resolver = createPublicMediaUrlResolver(storageWith("https://media.example.com"));
		expect(resolver("01ABC.jpg")).toBe("https://media.example.com/01ABC.jpg");
		expect(resolver("01XYZ.png")).toBe("https://media.example.com/01XYZ.png");
	});

	it("falls back to the internal proxy when no storage is given", () => {
		const resolver = createPublicMediaUrlResolver(null);
		expect(resolver("01ABC.jpg")).toBe("/_emdash/api/media/file/01ABC.jpg");
	});
});

describe("buildRenderMediaUrl", () => {
	const resolveCdn = (key: string) => `https://media.example.com/${key}`;

	it("routes an explicit storageKey through resolve", () => {
		expect(buildRenderMediaUrl(resolveCdn, { storageKey: "01ABC.jpg" })).toBe(
			"https://media.example.com/01ABC.jpg",
		);
	});

	it("uses the internal proxy for storageKey when resolve is absent", () => {
		expect(buildRenderMediaUrl(undefined, { storageKey: "01ABC.jpg" })).toBe(
			"/_emdash/api/media/file/01ABC.jpg",
		);
	});

	it("rewrites an internal url via resolve so publicUrl is honored", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "/_emdash/api/media/file/01ABC.jpg",
				id: "01ABC",
			}),
		).toBe("https://media.example.com/01ABC.jpg");
	});

	it("leaves an external url untouched even when resolve is given", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "https://other-cdn.example.com/01ABC.jpg",
			}),
		).toBe("https://other-cdn.example.com/01ABC.jpg");
	});

	it("returns an internal url as-is when no resolve is given", () => {
		expect(
			buildRenderMediaUrl(undefined, {
				url: "/_emdash/api/media/file/01ABC.jpg",
			}),
		).toBe("/_emdash/api/media/file/01ABC.jpg");
	});

	it("uses the internal proxy for a bare id", () => {
		expect(buildRenderMediaUrl(resolveCdn, { id: "01ABC" })).toBe("/_emdash/api/media/file/01ABC");
	});

	it("returns an empty string when no fields are usable", () => {
		expect(buildRenderMediaUrl(resolveCdn, {})).toBe("");
	});

	it("does not rewrite a url that only shares the media prefix", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "/_emdash/api/media/file-list/01ABC.jpg",
			}),
		).toBe("/_emdash/api/media/file-list/01ABC.jpg");
	});

	it("passes an internal url through when the captured key contains a slash", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "/_emdash/api/media/file/../other-tenant/secret.pdf",
			}),
		).toBe("/_emdash/api/media/file/../other-tenant/secret.pdf");
	});

	it("passes an internal url through when the captured key contains a query string", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "/_emdash/api/media/file/01ABC.jpg?v=2",
			}),
		).toBe("/_emdash/api/media/file/01ABC.jpg?v=2");
	});

	it("passes an internal url through when the captured key is percent-encoded", () => {
		expect(
			buildRenderMediaUrl(resolveCdn, {
				url: "/_emdash/api/media/file/01%2FABC.jpg",
			}),
		).toBe("/_emdash/api/media/file/01%2FABC.jpg");
	});
});

describe("storageKeyFromLocalMediaFileUrl", () => {
	it("accepts absolute Copy URL links only for the trusted site origin", () => {
		const url =
			"https://SITE.example:443/_emdash/api/media/file/uploads/a%20file.pdf?download=1#page=2";
		expect(storageKeyFromLocalMediaFileUrl(url, "https://site.example")).toBe("uploads/a file.pdf");
		expect(storageKeyFromLocalMediaFileUrl(url)).toBeNull();
		expect(storageKeyFromLocalMediaFileUrl("/_emdash/api/media/file/a.pdf?x#y")).toBe("a.pdf");
	});

	it.each([
		"https://elsewhere.example/_emdash/api/media/file/a.pdf",
		"https://site.example.evil.test/_emdash/api/media/file/a.pdf",
		"https://site.example:8443/_emdash/api/media/file/a.pdf",
		"http://site.example/_emdash/api/media/file/a.pdf",
		"//site.example/_emdash/api/media/file/a.pdf",
		"https://user:password@site.example/_emdash/api/media/file/a.pdf",
		"https://site.example/not-media/a.pdf",
		"https://site.example/_emdash/api/media/file/%ZZ",
		"See https://site.example/_emdash/api/media/file/a.pdf",
	])("rejects unrelated or malformed URLs: %s", (url) => {
		expect(storageKeyFromLocalMediaFileUrl(url, "https://site.example")).toBeNull();
	});
});
