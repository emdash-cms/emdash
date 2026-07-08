import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../../src/api/openapi/document.js";

describe("OpenAPI document generation", () => {
	it("generates a valid OpenAPI 3.1 document", () => {
		const doc = generateOpenApiDocument();

		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("EmDash CMS API");
		expect(doc.info.version).toBe("0.1.0");
	});

	it("includes content paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/content/{collection}");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}/publish");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}/schedule");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}/duplicate");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}/compare");
		expect(paths).toContain("/_emdash/api/content/{collection}/{id}/translations");
		expect(paths).toContain("/_emdash/api/content/{collection}/trash");
	});

	it("includes media paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/media");
		expect(paths).toContain("/_emdash/api/media/{id}");
		expect(paths).toContain("/_emdash/api/media/upload-url");
		expect(paths).toContain("/_emdash/api/media/{id}/confirm");
	});

	it("includes schema paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/schema/collections");
		expect(paths).toContain("/_emdash/api/schema/collections/{slug}");
		expect(paths).toContain("/_emdash/api/schema/collections/{slug}/fields");
		expect(paths).toContain("/_emdash/api/schema/collections/{slug}/fields/{fieldSlug}");
		expect(paths).toContain("/_emdash/api/schema/orphans");
	});

	it("includes comments paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/comments/{collection}/{contentId}");
		expect(paths).toContain("/_emdash/api/admin/comments");
		expect(paths).toContain("/_emdash/api/admin/comments/counts");
		expect(paths).toContain("/_emdash/api/admin/comments/bulk");
		expect(paths).toContain("/_emdash/api/admin/comments/{id}");
	});

	it("includes taxonomy paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/taxonomies");
		expect(paths).toContain("/_emdash/api/taxonomies/{name}/terms");
		expect(paths).toContain("/_emdash/api/taxonomies/{name}/terms/{slug}");
	});

	it("includes menu paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/menus");
		expect(paths).toContain("/_emdash/api/menus/{name}");
		expect(paths).toContain("/_emdash/api/menus/{name}/items");
		expect(paths).toContain("/_emdash/api/menus/{name}/reorder");
	});

	it("includes section paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/sections");
		expect(paths).toContain("/_emdash/api/sections/{slug}");
	});

	it("includes widget paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/widget-areas");
		expect(paths).toContain("/_emdash/api/widget-areas/{name}");
		expect(paths).toContain("/_emdash/api/widget-areas/{name}/widgets");
		expect(paths).toContain("/_emdash/api/widget-areas/{name}/widgets/{id}");
		expect(paths).toContain("/_emdash/api/widget-areas/{name}/reorder");
	});

	it("includes settings paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/settings");
	});

	it("includes search paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/search");
		expect(paths).toContain("/_emdash/api/search/suggest");
		expect(paths).toContain("/_emdash/api/search/rebuild");
		expect(paths).toContain("/_emdash/api/search/enable");
		expect(paths).toContain("/_emdash/api/search/stats");
	});

	it("includes redirect paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/redirects");
		expect(paths).toContain("/_emdash/api/redirects/{id}");
		expect(paths).toContain("/_emdash/api/redirects/404s");
		expect(paths).toContain("/_emdash/api/redirects/404s/summary");
	});

	it("includes user paths", () => {
		const doc = generateOpenApiDocument();
		const paths = Object.keys(doc.paths ?? {});

		expect(paths).toContain("/_emdash/api/admin/users");
		expect(paths).toContain("/_emdash/api/admin/users/{id}");
		expect(paths).toContain("/_emdash/api/admin/users/{id}/disable");
		expect(paths).toContain("/_emdash/api/admin/users/{id}/enable");
		expect(paths).toContain("/_emdash/api/admin/allowed-domains");
		expect(paths).toContain("/_emdash/api/admin/allowed-domains/{domain}");
	});

	it("has correct HTTP methods on content collection endpoint", () => {
		const doc = generateOpenApiDocument();
		const collectionPath = doc.paths?.["/_emdash/api/content/{collection}"];

		expect(collectionPath).toBeDefined();
		expect(collectionPath).toHaveProperty("get");
		expect(collectionPath).toHaveProperty("post");
	});

	it("has correct HTTP methods on content item endpoint", () => {
		const doc = generateOpenApiDocument();
		const itemPath = doc.paths?.["/_emdash/api/content/{collection}/{id}"];

		expect(itemPath).toBeDefined();
		expect(itemPath).toHaveProperty("get");
		expect(itemPath).toHaveProperty("put");
		expect(itemPath).toHaveProperty("delete");
	});

	it("documents locale query parameter on content item update", () => {
		const doc = generateOpenApiDocument();
		const itemPath = doc.paths?.["/_emdash/api/content/{collection}/{id}"];
		const updateOp = itemPath?.put as {
			parameters?: Array<{ name?: string; in?: string }>;
		};

		expect(updateOp.parameters).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "locale", in: "query" })]),
		);
	});

	it("generates unique operation IDs for all operations", () => {
		const doc = generateOpenApiDocument();
		const operationIds: string[] = [];

		for (const pathItem of Object.values(doc.paths ?? {})) {
			for (const method of ["get", "post", "put", "delete", "patch"] as const) {
				const op = (pathItem as Record<string, unknown>)?.[method] as
					| { operationId?: string }
					| undefined;
				if (op?.operationId) {
					operationIds.push(op.operationId);
				}
			}
		}

		// Content operations
		expect(operationIds).toContain("listContent");
		expect(operationIds).toContain("createContent");
		expect(operationIds).toContain("getContent");
		expect(operationIds).toContain("updateContent");
		expect(operationIds).toContain("deleteContent");
		expect(operationIds).toContain("publishContent");
		expect(operationIds).toContain("duplicateContent");

		// Media operations
		expect(operationIds).toContain("listMedia");
		expect(operationIds).toContain("getMedia");
		expect(operationIds).toContain("deleteMedia");
		expect(operationIds).toContain("getMediaUploadUrl");

		// Schema operations
		expect(operationIds).toContain("listCollections");
		expect(operationIds).toContain("createCollection");
		expect(operationIds).toContain("listFields");
		expect(operationIds).toContain("createField");

		// Comments operations
		expect(operationIds).toContain("listPublicComments");
		expect(operationIds).toContain("createComment");
		expect(operationIds).toContain("listAdminComments");
		expect(operationIds).toContain("bulkCommentAction");

		// Taxonomy operations
		expect(operationIds).toContain("listTaxonomies");
		expect(operationIds).toContain("listTerms");
		expect(operationIds).toContain("createTerm");

		// Menu operations
		expect(operationIds).toContain("listMenus");
		expect(operationIds).toContain("createMenu");
		expect(operationIds).toContain("createMenuItem");

		// Section operations
		expect(operationIds).toContain("listSections");
		expect(operationIds).toContain("createSection");

		// Widget operations
		expect(operationIds).toContain("listWidgetAreas");
		expect(operationIds).toContain("createWidget");

		// Settings operations
		expect(operationIds).toContain("getSettings");
		expect(operationIds).toContain("updateSettings");

		// Search operations
		expect(operationIds).toContain("search");
		expect(operationIds).toContain("rebuildSearchIndex");

		// Redirect operations
		expect(operationIds).toContain("listRedirects");
		expect(operationIds).toContain("createRedirect");
		expect(operationIds).toContain("listNotFoundEntries");

		// User operations
		expect(operationIds).toContain("listUsers");
		expect(operationIds).toContain("getUser");
		expect(operationIds).toContain("disableUser");

		// No duplicate operation IDs
		const uniqueIds = new Set(operationIds);
		expect(uniqueIds.size).toBe(operationIds.length);
	});

	it("includes reusable component schemas", () => {
		const doc = generateOpenApiDocument();
		const schemas = doc.components?.schemas ?? {};

		// Content schemas
		expect(schemas).toHaveProperty("ContentCreateBody");
		expect(schemas).toHaveProperty("ContentUpdateBody");
		expect(schemas).toHaveProperty("ContentItem");
		expect(schemas).toHaveProperty("ContentResponse");
		expect(schemas).toHaveProperty("ContentListResponse");

		// Media schemas
		expect(schemas).toHaveProperty("MediaItem");
		expect(schemas).toHaveProperty("MediaListResponse");

		// Schema schemas
		expect(schemas).toHaveProperty("Collection");
		expect(schemas).toHaveProperty("CollectionListResponse");

		// Comment schemas
		expect(schemas).toHaveProperty("PublicComment");
		expect(schemas).toHaveProperty("Comment");
		expect(schemas).toHaveProperty("CommentBulkBody");

		// Taxonomy schemas
		expect(schemas).toHaveProperty("Term");
		expect(schemas).toHaveProperty("TermListResponse");

		// Menu schemas
		expect(schemas).toHaveProperty("MenuWithItems");

		// User schemas
		expect(schemas).toHaveProperty("User");
		expect(schemas).toHaveProperty("UserListResponse");
	});

	it("wraps success responses in { data } envelope", () => {
		const doc = generateOpenApiDocument();
		const listPath = doc.paths?.["/_emdash/api/content/{collection}"];
		const getResponse = (listPath as Record<string, unknown>)?.get as {
			responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
		};
		const schema = getResponse?.responses?.["200"]?.content?.["application/json"]?.schema;

		expect(schema).toBeDefined();
		// The envelope should have a "data" property
		expect(schema).toHaveProperty("properties");
		const props = (schema as Record<string, unknown>).properties as Record<string, unknown>;
		expect(props).toHaveProperty("data");
	});

	it("includes error response schemas", () => {
		const doc = generateOpenApiDocument();
		const listPath = doc.paths?.["/_emdash/api/content/{collection}"];
		const getOp = (listPath as Record<string, unknown>)?.get as {
			responses: Record<string, unknown>;
		};

		// Should have auth error responses
		expect(getOp?.responses).toHaveProperty("401");
		expect(getOp?.responses).toHaveProperty("403");
	});

	it("includes security schemes", () => {
		const doc = generateOpenApiDocument();
		const schemes = doc.components?.securitySchemes;

		expect(schemes).toHaveProperty("session");
		expect(schemes).toHaveProperty("bearer");
	});

	it("tags all 12 domains", () => {
		const doc = generateOpenApiDocument();
		const tagNames = (doc.tags ?? []).map((t: { name: string }) => t.name);

		expect(tagNames).toContain("Content");
		expect(tagNames).toContain("Media");
		expect(tagNames).toContain("Schema");
		expect(tagNames).toContain("Comments");
		expect(tagNames).toContain("Taxonomies");
		expect(tagNames).toContain("Menus");
		expect(tagNames).toContain("Sections");
		expect(tagNames).toContain("Widgets");
		expect(tagNames).toContain("Settings");
		expect(tagNames).toContain("Search");
		expect(tagNames).toContain("Redirects");
		expect(tagNames).toContain("Users");
		expect(tagNames).toHaveLength(12);
	});

	it("produces valid JSON output", () => {
		const doc = generateOpenApiDocument();
		const json = JSON.stringify(doc);

		// Should not throw
		const parsed = JSON.parse(json);
		expect(parsed.openapi).toBe("3.1.0");
	});
});
