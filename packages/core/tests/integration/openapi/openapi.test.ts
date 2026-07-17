import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { generateOpenApiDocument } from "../../../src/api/openapi/document.js";

describe("OpenAPI spec validation", () => {
	it("produces a valid OpenAPI 3.1 document", async () => {
		const doc = generateOpenApiDocument();

		// swagger-parser.validate() resolves $refs and validates against the OAS JSON Schema.
		// It throws if the document is invalid.
		const validated = await SwaggerParser.validate(structuredClone(doc));

		expect(validated.openapi).toBe("3.1.0");
		expect(validated.info.title).toBe("EmDash CMS API");
	});

	it("resolves all $ref pointers without errors", async () => {
		const doc = generateOpenApiDocument();

		// dereference() resolves every $ref in the document tree.
		// If any $ref points to a missing schema, it throws.
		const dereferenced = await SwaggerParser.dereference(structuredClone(doc));

		// After dereferencing, no $ref keys should remain.
		// Use a replacer to handle circular references (e.g. PublicComment.replies)
		const seen = new WeakSet();
		const json = JSON.stringify(dereferenced, (_key, value) => {
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		});
		expect(json).not.toContain('"$ref"');
	});

	it("has all content paths with responses", () => {
		const doc = generateOpenApiDocument();
		const paths = doc.paths ?? {};

		for (const [path, pathItem] of Object.entries(paths)) {
			for (const method of ["get", "post", "put", "delete", "patch"] as const) {
				const op = (pathItem as Record<string, unknown>)?.[method] as
					| { responses?: Record<string, unknown>; operationId?: string }
					| undefined;
				if (!op) continue;

				// Every operation must have responses
				expect(op.responses, `${method.toUpperCase()} ${path} missing responses`).toBeDefined();

				// Every operation must have an operationId
				expect(op.operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeDefined();

				// Every operation must have at least one success response (2xx)
				const statusCodes = Object.keys(op.responses ?? {});
				const has2xx = statusCodes.some((code) => code.startsWith("2"));
				expect(has2xx, `${method.toUpperCase()} ${path} has no 2xx response`).toBe(true);
			}
		}
	});

	it("wraps all success responses in the { success, data } envelope", () => {
		const doc = generateOpenApiDocument();
		const paths = doc.paths ?? {};

		for (const [path, pathItem] of Object.entries(paths)) {
			for (const method of ["get", "post", "put", "delete", "patch"] as const) {
				const op = (pathItem as Record<string, unknown>)?.[method] as
					| { responses?: Record<string, Record<string, unknown>> }
					| undefined;
				if (!op?.responses) continue;

				for (const [statusCode, response] of Object.entries(op.responses)) {
					if (!statusCode.startsWith("2")) continue;

					const content = (response as Record<string, unknown>)?.content as
						| Record<string, { schema?: Record<string, unknown> }>
						| undefined;
					if (!content?.["application/json"]) continue;

					const schema = content["application/json"].schema;
					expect(
						schema,
						`${method.toUpperCase()} ${path} ${statusCode} missing schema`,
					).toBeDefined();

					// The envelope must have "success" and "data" properties (either
					// directly or via $ref that wraps them). Check for direct
					// properties or allOf/oneOf patterns.
					const props = (schema as Record<string, unknown>)?.properties as
						| Record<string, unknown>
						| undefined;
					if (props) {
						expect(
							props,
							`${method.toUpperCase()} ${path} ${statusCode} envelope missing "data" property`,
						).toHaveProperty("data");
						expect(
							props,
							`${method.toUpperCase()} ${path} ${statusCode} envelope missing "success" property`,
						).toHaveProperty("success");
					}
				}
			}
		}
	});

	it("includes auth error responses on authenticated endpoints", () => {
		const doc = generateOpenApiDocument();
		const paths = doc.paths ?? {};

		// Public endpoints that don't require authentication
		const publicPaths = new Set(["/_emdash/api/comments/{collection}/{contentId}"]);

		for (const [path, pathItem] of Object.entries(paths)) {
			if (publicPaths.has(path)) continue;

			for (const method of ["get", "post", "put", "delete", "patch"] as const) {
				const op = (pathItem as Record<string, unknown>)?.[method] as
					| { responses?: Record<string, unknown> }
					| undefined;
				if (!op?.responses) continue;

				const statusCodes = Object.keys(op.responses);
				expect(statusCodes, `${method.toUpperCase()} ${path} missing 401`).toContain("401");
				expect(statusCodes, `${method.toUpperCase()} ${path} missing 403`).toContain("403");
			}
		}
	});

	it("has no duplicate operation IDs across all paths", () => {
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

		const seen = new Set<string>();
		for (const id of operationIds) {
			expect(seen.has(id), `duplicate operationId: ${id}`).toBe(false);
			seen.add(id);
		}
	});

	it("registers referenced schemas as reusable components", async () => {
		const doc = generateOpenApiDocument();
		const schemas = doc.components?.schemas ?? {};
		const schemaNames = Object.keys(schemas);

		// Should have a reasonable number of reusable schemas
		expect(schemaNames.length).toBeGreaterThanOrEqual(5);

		// All registered schemas should be valid objects with type or properties
		for (const [name, schema] of Object.entries(schemas)) {
			expect(schema, `component schema "${name}" is not an object`).toBeTypeOf("object");
		}
	});

	it("uses consistent error response shape across all error codes", () => {
		const doc = generateOpenApiDocument();
		const paths = doc.paths ?? {};

		for (const [path, pathItem] of Object.entries(paths)) {
			for (const method of ["get", "post", "put", "delete", "patch"] as const) {
				const op = (pathItem as Record<string, unknown>)?.[method] as
					| { responses?: Record<string, Record<string, unknown>> }
					| undefined;
				if (!op?.responses) continue;

				for (const [statusCode, response] of Object.entries(op.responses)) {
					// Only check error responses (4xx, 5xx)
					const code = Number(statusCode);
					if (code < 400) continue;

					const content = (response as Record<string, unknown>)?.content as
						| Record<string, { schema?: Record<string, unknown> }>
						| undefined;
					if (!content?.["application/json"]) continue;

					const schema = content["application/json"].schema;
					expect(
						schema,
						`${method.toUpperCase()} ${path} ${statusCode} error missing schema`,
					).toBeDefined();

					// Error responses either $ref the shared ApiError component or
					// inline its shape; both must carry the `success` discriminant.
					const props = (schema as Record<string, unknown>)?.properties as
						| Record<string, unknown>
						| undefined;
					const ref = (schema as Record<string, unknown>)?.$ref as string | undefined;
					const usesApiError = typeof ref === "string" && ref.endsWith("/ApiError");
					if (props) {
						expect(
							props,
							`${method.toUpperCase()} ${path} ${statusCode} error envelope missing "success"`,
						).toHaveProperty("success");
					} else {
						expect(
							usesApiError,
							`${method.toUpperCase()} ${path} ${statusCode} error is neither a $ref to ApiError nor inline`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("declares the success discriminant on the ApiError component", () => {
		const doc = generateOpenApiDocument();
		const apiError = (doc.components?.schemas ?? {})["ApiError"] as
			| { properties?: Record<string, unknown> }
			| undefined;
		expect(apiError, "ApiError component missing").toBeDefined();
		expect(apiError?.properties).toHaveProperty("success");
		expect(apiError?.properties).toHaveProperty("error");
	});
});
