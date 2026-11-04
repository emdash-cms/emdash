import { describe, expect, it } from "vitest";

import type {
	CollectionRecord,
	EntryRecord,
	RedirectRecord,
} from "../../../src/transfer/format/kinds.js";
import {
	applyTransformations,
	importTransformationSchema,
	type TransformationContext,
	type TransformationPlan,
} from "../../../src/transfer/format/transformations.js";

const context: TransformationContext = {
	fieldColumnTypes: new Map([
		[
			"posts",
			new Map([
				["rating", "REAL"],
				["count", "INTEGER"],
				["title", "TEXT"],
			] as const),
		],
	]),
};

function plan(overrides: Partial<TransformationPlan> = {}): TransformationPlan {
	return {
		transformations: [],
		decisions: { principalMappings: { alice: "target-alice", bob: null } },
		...overrides,
	};
}

const entry: EntryRecord = {
	kind: "entry",
	id: "e1",
	collection: "posts",
	locale: "en",
	authorPrincipal: "alice",
	fields: { title: "Hello", rating: 0.1, count: 3 },
};

describe("applyTransformations", () => {
	it("maps principals and drops unmapped or unknown ones", () => {
		expect(applyTransformations(entry, plan(), context).authorPrincipal).toBe("target-alice");
		expect(
			"authorPrincipal" in
				applyTransformations({ ...entry, authorPrincipal: "bob" }, plan(), context),
		).toBe(false);
		expect(
			"authorPrincipal" in
				applyTransformations({ ...entry, authorPrincipal: "stranger" }, plan(), context),
		).toBe(false);
		expect(
			applyTransformations(
				{
					kind: "byline",
					id: "b",
					slug: "a",
					displayName: "A",
					isGuest: false,
					locale: "en",
					userPrincipal: "alice",
				},
				plan(),
				context,
			).userPrincipal,
		).toBe("target-alice");
	});

	it("does not mutate its input", () => {
		const copy = structuredClone(entry);
		applyTransformations(
			entry,
			plan({ transformations: [{ code: "float4_rounded", count: 1 }] }),
			context,
		);
		expect(entry).toEqual(copy);
	});

	it("disables looping redirects and search on unsupported targets", () => {
		const redirect: RedirectRecord = {
			kind: "redirect",
			id: "r1",
			source: "/a",
			destination: "/b",
			type: 301,
			isPattern: false,
			enabled: true,
			auto: false,
		};
		const redirectPlan = plan({
			transformations: [{ code: "redirect_loop_disabled", kind: "redirect", ids: ["r1"] }],
		});
		expect(applyTransformations(redirect, redirectPlan, context).enabled).toBe(false);
		expect(applyTransformations({ ...redirect, id: "r2" }, redirectPlan, context).enabled).toBe(
			true,
		);

		const collection: CollectionRecord = {
			kind: "collection",
			id: "c1",
			slug: "posts",
			label: "Posts",
			hasSeo: false,
			hidden: false,
			routable: true,
			editLocking: true,
			searchConfig: { enabled: true, weights: { title: 2 } },
		};
		const searchPlan = plan({
			transformations: [{ code: "search_unsupported", kind: "collection", ids: ["c1"] }],
		});
		expect(applyTransformations(collection, searchPlan, context).searchConfig).toEqual({
			enabled: false,
			weights: { title: 2 },
		});
	});

	it("leaves principals and unaffected kinds unchanged", () => {
		const principal = { kind: "principal", id: "alice", displayName: "Alice" } as const;
		expect(applyTransformations(principal, plan(), context)).toEqual(principal);
	});
});

describe("importTransformationSchema", () => {
	it("rejects unknown codes and extra properties", () => {
		expect(importTransformationSchema.safeParse({ code: "made_up", count: 1 }).success).toBe(false);
		expect(
			importTransformationSchema.safeParse({ code: "float4_rounded", count: 1, extra: true })
				.success,
		).toBe(false);
	});
});
