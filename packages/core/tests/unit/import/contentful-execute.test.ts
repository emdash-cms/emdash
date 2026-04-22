import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Role } from "@emdash-cms/auth";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { handleContentUpdate } from "../../../src/api/handlers/content.js";
import { POST } from "../../../src/astro/routes/api/import/contentful/execute.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { EmDashManifest } from "../../../src/astro/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Contentful import execute route", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("imports same-slug posts into their source locales", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
			i18n: {
				defaultLocale: "en",
				locales: ["en", "fr"],
			},
		};

		const payload = {
			items: [
				{
					sys: {
						id: "post-en",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						locale: "en",
						contentType: { sys: { id: "blogPost" } },
					},
					fields: {
						title: "English post",
						slug: "same-slug",
						content: {
							nodeType: "document",
							data: {},
							content: [],
						},
					},
				},
				{
					sys: {
						id: "post-fr",
						type: "Entry",
						createdAt: "2025-01-02T00:00:00Z",
						updatedAt: "2025-01-02T00:00:00Z",
						locale: "fr",
						contentType: { sys: { id: "blogPost" } },
					},
					fields: {
						title: "French post",
						slug: "same-slug",
						content: {
							nodeType: "document",
							data: {},
							content: [],
						},
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data: {
				success: boolean;
				posts: { created: number; errors: Array<{ title: string; error: string }> };
			};
		};
		expect(json.data.success).toBe(true);
		expect(json.data.posts.created).toBe(2);
		expect(json.data.posts.errors).toEqual([]);

		const repo = new ContentRepository(db);
		const englishPost = await repo.findBySlug("posts", "same-slug", "en");
		const frenchPost = await repo.findBySlug("posts", "same-slug", "fr");
		expect(englishPost).toMatchObject({ locale: "en" });
		expect(englishPost?.data.title).toBe("English post");
		expect(frenchPost).toMatchObject({ locale: "fr" });
		expect(frenchPost?.data.title).toBe("French post");
	});

	it("uses config.locale as an explicit override for imported posts", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
			i18n: {
				defaultLocale: "en",
				locales: ["en", "fr"],
			},
		};

		const payload = {
			items: [
				{
					sys: {
						id: "post-en",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						locale: "en",
						contentType: { sys: { id: "blogPost" } },
					},
					fields: {
						title: "English post",
						slug: "english-post",
						content: {
							nodeType: "document",
							data: {},
							content: [],
						},
					},
				},
				{
					sys: {
						id: "post-fr",
						type: "Entry",
						createdAt: "2025-01-02T00:00:00Z",
						updatedAt: "2025-01-02T00:00:00Z",
						locale: "fr",
						contentType: { sys: { id: "blogPost" } },
					},
					fields: {
						title: "French post",
						slug: "french-post",
						content: {
							nodeType: "document",
							data: {},
							content: [],
						},
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);
		formData.set("config", JSON.stringify({ locale: "en" }));

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const repo = new ContentRepository(db);
		expect(await repo.findBySlug("posts", "english-post", "en")).toBeTruthy();
		expect(await repo.findBySlug("posts", "french-post", "en")).toBeTruthy();
		expect(await repo.findBySlug("posts", "french-post", "fr")).toBeNull();
	});

	it("filters author fields to the target schema before creating authors", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "authors",
			label: "Authors",
			labelSingular: "Author",
		});
		await registry.createField("authors", {
			slug: "name",
			label: "Name",
			type: "string",
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				authors: {
					label: "Authors",
					labelSingular: "Author",
					supports: [],
					hasSeo: false,
					fields: {
						name: { kind: "string" },
					},
				},
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
			i18n: {
				defaultLocale: "en",
				locales: ["en"],
			},
		};

		const payload = {
			items: [
				{
					sys: {
						id: "author-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						locale: "en",
						contentType: { sys: { id: "blogAuthor" } },
					},
					fields: {
						name: "Schema-safe author",
						slug: "schema-safe-author",
						bio: "Will be ignored",
						jobTitle: "Ignored too",
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
					handleContentUpdate: (
						collection: string,
						id: string,
						body: Parameters<typeof handleContentUpdate>[3],
					) => handleContentUpdate(db, collection, id, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data: {
				success: boolean;
				authors: { created: number; errors: string[] };
			};
		};
		expect(json.data.success).toBe(true);
		expect(json.data.authors.created).toBe(1);
		expect(json.data.authors.errors).toEqual([]);

		const repo = new ContentRepository(db);
		const author = await repo.findBySlug("authors", "schema-safe-author", "en");
		expect(author?.data).toEqual({ name: "Schema-safe author" });
	});

	it("updates existing authors instead of only reporting them", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "authors",
			label: "Authors",
			labelSingular: "Author",
		});
		await registry.createField("authors", {
			slug: "name",
			label: "Name",
			type: "string",
		});
		await registry.createField("authors", {
			slug: "bio",
			label: "Bio",
			type: "text",
		});
		await registry.createField("authors", {
			slug: "job_title",
			label: "Job title",
			type: "string",
		});
		await registry.createField("authors", {
			slug: "profile_image",
			label: "Profile image",
			type: "image",
		});

		await handleContentCreate(db, "authors", {
			data: { name: "Old name", bio: "Old bio", job_title: "Old title" },
			slug: "jane",
			status: "published",
			locale: "en",
		});
		const bylineRepo = new BylineRepository(db);
		await bylineRepo.create({
			slug: "jane",
			displayName: "Old name",
			userId: null,
			isGuest: true,
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				authors: {
					label: "Authors",
					labelSingular: "Author",
					supports: [],
					hasSeo: false,
					fields: {
						name: { kind: "string" },
						bio: { kind: "text" },
						job_title: { kind: "string" },
						profile_image: { kind: "image" },
					},
				},
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
			i18n: {
				defaultLocale: "en",
				locales: ["en"],
			},
		};

		const payload = {
			items: [
				{
					sys: {
						id: "author-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						locale: "en",
						contentType: { sys: { id: "blogAuthor" } },
					},
					fields: {
						name: "New name",
						slug: "jane",
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
					handleContentUpdate: (
						collection: string,
						id: string,
						body: Parameters<typeof handleContentUpdate>[3],
					) => handleContentUpdate(db, collection, id, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data: {
				success: boolean;
				authors: { created: number; skipped: number; updated: number };
			};
		};
		expect(json.data.success).toBe(true);
		expect(json.data.authors.created).toBe(0);
		expect(json.data.authors.skipped).toBe(0);
		expect(json.data.authors.updated).toBe(1);

		const repo = new ContentRepository(db);
		const author = await repo.findBySlug("authors", "jane", "en");
		expect(author?.data.name).toBe("New name");
		expect(author?.data.bio).toBeUndefined();
		expect(author?.data.job_title).toBeUndefined();
		const byline = await bylineRepo.findBySlug("jane");
		expect(byline?.displayName).toBe("New name");
	});

	it("keeps existing byline names anchored to the default locale", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "authors",
			label: "Authors",
			labelSingular: "Author",
		});
		await registry.createField("authors", {
			slug: "name",
			label: "Name",
			type: "string",
		});
		await registry.createField("authors", {
			slug: "bio",
			label: "Bio",
			type: "text",
		});
		await registry.createField("authors", {
			slug: "job_title",
			label: "Job title",
			type: "string",
		});
		await registry.createField("authors", {
			slug: "profile_image",
			label: "Profile image",
			type: "image",
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				authors: {
					label: "Authors",
					labelSingular: "Author",
					supports: [],
					hasSeo: false,
					fields: {
						name: { kind: "string" },
						bio: { kind: "text" },
						job_title: { kind: "string" },
						profile_image: { kind: "image" },
					},
				},
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
			i18n: {
				defaultLocale: "en",
				locales: ["en", "fr"],
			},
		};

		const payload = {
			items: [
				{
					sys: {
						id: "author-fr",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						locale: "fr",
						contentType: { sys: { id: "blogAuthor" } },
					},
					fields: {
						name: "Jean Exemple",
						slug: "jane",
					},
				},
				{
					sys: {
						id: "author-en",
						type: "Entry",
						createdAt: "2025-01-02T00:00:00Z",
						updatedAt: "2025-01-02T00:00:00Z",
						locale: "en",
						contentType: { sys: { id: "blogAuthor" } },
					},
					fields: {
						name: "Jane Example",
						slug: "jane",
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
					handleContentUpdate: (
						collection: string,
						id: string,
						body: Parameters<typeof handleContentUpdate>[3],
					) => handleContentUpdate(db, collection, id, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const bylineRepo = new BylineRepository(db);
		const byline = await bylineRepo.findBySlug("jane");
		expect(byline?.displayName).toBe("Jane Example");
	});

	it("ignores Contentful SEO fields when the target posts collection has SEO disabled", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
		});
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});

		const manifest: EmDashManifest = {
			version: "test",
			hash: "test",
			collections: {
				posts: {
					label: "Posts",
					labelSingular: "Post",
					supports: [],
					hasSeo: false,
					fields: {
						title: { kind: "string" },
						content: { kind: "portableText" },
					},
				},
			},
			plugins: {},
			authMode: "passkey",
			taxonomies: [],
		};

		const payload = {
			items: [
				{
					sys: {
						id: "post-1",
						type: "Entry",
						createdAt: "2025-01-01T00:00:00Z",
						updatedAt: "2025-01-01T00:00:00Z",
						contentType: { sys: { id: "blogPost" } },
					},
					fields: {
						title: "SEO post",
						slug: "seo-post",
						metaDescription: "Should not fail import",
						publiclyIndex: false,
						content: {
							nodeType: "document",
							data: {},
							content: [],
						},
					},
				},
			],
			includes: {},
		};

		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify(payload)], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					db,
					handleContentCreate: (collection: string, body: Parameters<typeof handleContentCreate>[2]) =>
						handleContentCreate(db, collection, body),
				},
				emdashManifest: manifest,
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		const json = (await response.json()) as {
			data: {
				success: boolean;
				posts: { created: number; errors: Array<{ title: string; error: string }> };
			};
		};
		expect(json.data.success).toBe(true);
		expect(json.data.posts.created).toBe(1);
		expect(json.data.posts.errors).toEqual([]);
	});

	it("returns a validation error for malformed config JSON", async () => {
		const formData = new FormData();
		formData.set(
			"file",
			new File([JSON.stringify({ items: [], includes: {} })], "contentful.json", {
				type: "application/json",
			}),
		);
		formData.set("config", "{not-json");

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					handleContentCreate: () => Promise.resolve({ success: true }),
				},
				emdashManifest: {
					version: "test",
					hash: "test",
					collections: {},
					plugins: {},
					authMode: "passkey",
					taxonomies: [],
				},
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "Invalid import config JSON",
			},
		});
	});

	it("returns a validation error for malformed export JSON", async () => {
		const formData = new FormData();
		formData.set(
			"file",
			new File(["{not-json"], "contentful.json", {
				type: "application/json",
			}),
		);

		const response = await POST({
			request: new Request("https://example.com/_emdash/api/import/contentful/execute", {
				method: "POST",
				body: formData,
			}),
			locals: {
				emdash: {
					handleContentCreate: () => Promise.resolve({ success: true }),
				},
				emdashManifest: {
					version: "test",
					hash: "test",
					collections: {},
					plugins: {},
					authMode: "passkey",
					taxonomies: [],
				},
				user: { id: "admin", role: Role.ADMIN },
			},
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "VALIDATION_ERROR",
				message: "Invalid Contentful export JSON",
			},
		});
	});
});
