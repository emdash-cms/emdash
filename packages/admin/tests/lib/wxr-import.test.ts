import { afterEach, describe, expect, it, vi } from "vitest";

import { executeWxrImport, type ImportResult } from "../../src/lib/api/import.js";

function result(overrides: Partial<ImportResult> = {}): ImportResult {
	return {
		success: true,
		imported: 0,
		skipped: 0,
		errors: [],
		byCollection: {},
		...overrides,
	};
}

function response(data: unknown): Response {
	return Response.json({ success: true, data });
}

describe("executeWxrImport", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drives every phase and aggregates content, taxonomy, and section results", async () => {
		const cursor = {
			offset: 0,
			source: "a".repeat(64),
			taxonomiesReady: true as const,
		};
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				response({
					success: true,
					done: true,
					cursor,
					chunk: { translationGroups: {} },
					result: result({
						taxonomies: {
							termsCreated: { category: 2 },
							termsReused: {},
							assignments: 0,
							missingTaxonomies: [],
						},
					}),
				}),
			)
			.mockResolvedValueOnce(
				response({
					success: true,
					done: false,
					cursor: { ...cursor, offset: 30 },
					chunk: { translationGroups: { group: "entry-1" } },
					result: result({
						imported: 30,
						byCollection: { posts: 30 },
						taxonomies: {
							termsCreated: {},
							termsReused: {},
							assignments: 8,
							missingTaxonomies: [],
						},
					}),
				}),
			)
			.mockResolvedValueOnce(
				response({
					success: true,
					done: true,
					cursor: { ...cursor, offset: 35 },
					chunk: { translationGroups: { group: "entry-1" } },
					result: result({ imported: 5, byCollection: { posts: 5 } }),
				}),
			)
			.mockResolvedValueOnce(
				response({
					success: true,
					done: true,
					result: result({ sections: { created: 1, skipped: 0 } }),
				}),
			);

		const phases: string[] = [];
		const imported = await executeWxrImport(
			new File(["<rss />"], "export.xml", { type: "text/xml" }),
			{
				postTypeMappings: { post: { collection: "posts", enabled: true } },
				skipExisting: true,
			},
			(progress) => phases.push(progress.phase),
		);

		expect(imported).toMatchObject({
			success: true,
			imported: 35,
			byCollection: { posts: 35 },
			sections: { created: 1, skipped: 0 },
			taxonomies: {
				termsCreated: { category: 2 },
				assignments: 8,
			},
		});
		expect(phases).toEqual(["taxonomy", "content", "content", "sections"]);
		expect(fetch).toHaveBeenCalledTimes(4);
		const requestPhases = fetch.mock.calls.map(([, init]) => {
			const body = init?.body;
			expect(body).toBeInstanceOf(FormData);
			return (body as FormData).get("phase");
		});
		expect(requestPhases).toEqual(["taxonomy", "content", "content", "finalize"]);
	});
});
