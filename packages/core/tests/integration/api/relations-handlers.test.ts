import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleRelationCreate,
	handleRelationGet,
	handleRelationList,
	handleRelationUpdate,
	handleRelationDelete,
	handleRelationTranslations,
} from "../../../src/api/handlers/relations.js";
import { PATCH as patchRelation } from "../../../src/astro/routes/api/relations/[id]/index.js";
import {
	GET as listRelations,
	POST as createRelation,
} from "../../../src/astro/routes/api/relations/index.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// setupForDialectWithCollections registers two collections: "post" and "page".
// Relation create validates that both collections exist, so the handler tests
// use those real slugs rather than fabricated names.
const baseInput = {
	name: "manages",
	parentCollection: "post",
	childCollection: "post",
	parentLabel: "Manager",
	childLabel: "Direct report",
};

describeEachDialect("relations definition handlers", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("create returns the new relation; get fetches it by id", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(created.success).toBe(true);
		if (!created.success) return;
		expect(created.data.relation.name).toBe("manages");
		expect(created.data.relation.translationGroup).toBe(created.data.relation.id);

		const fetched = await handleRelationGet(ctx.db, created.data.relation.id);
		expect(fetched.success).toBe(true);
		if (!fetched.success) return;
		expect(fetched.data.relation).toEqual(created.data.relation);
	});

	it("get returns NOT_FOUND for an unknown id", async () => {
		const result = await handleRelationGet(ctx.db, "nope");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("list returns relations ordered by name, filtered by locale", async () => {
		await handleRelationCreate(ctx.db, { ...baseInput, name: "writes", childCollection: "page" });
		await handleRelationCreate(ctx.db, { ...baseInput, name: "manages" });
		await handleRelationCreate(ctx.db, { ...baseInput, name: "supervises", locale: "fr" });

		const all = await handleRelationList(ctx.db, {});
		expect(all.success).toBe(true);
		if (!all.success) return;
		expect(all.data.relations.map((r) => r.name)).toEqual(["manages", "supervises", "writes"]);
		expect(all.data.relations.some((r) => r.locale === "fr")).toBe(true);

		const en = await handleRelationList(ctx.db, { locale: "en" });
		if (!en.success) return;
		expect(en.data.relations.map((r) => r.name)).toEqual(["manages", "writes"]);
		expect(en.data.relations.every((r) => r.locale === "en")).toBe(true);
		expect(en.data.relations.some((r) => r.name === "supervises")).toBe(false);
	});

	it("update changes only labels; unknown id is NOT_FOUND", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const updated = await handleRelationUpdate(ctx.db, created.data.relation.id, {
			parentLabel: "Lead",
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;
		expect(updated.data.relation.parentLabel).toBe("Lead");
		expect(updated.data.relation.name).toBe("manages");

		const missing = await handleRelationUpdate(ctx.db, "nope", { parentLabel: "x" });
		expect(missing.success).toBe(false);
		if (missing.success) return;
		expect(missing.error.code).toBe("NOT_FOUND");
	});

	it("delete removes the relation; unknown id is NOT_FOUND", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const del = await handleRelationDelete(ctx.db, created.data.relation.id);
		expect(del.success).toBe(true);
		expect((await handleRelationGet(ctx.db, created.data.relation.id)).success).toBe(false);

		const missing = await handleRelationDelete(ctx.db, "nope");
		expect(missing.success).toBe(false);
		if (missing.success) return;
		expect(missing.error.code).toBe("NOT_FOUND");
	});

	it("create against a non-existent collection is COLLECTION_NOT_FOUND", async () => {
		const result = await handleRelationCreate(ctx.db, { ...baseInput, parentCollection: "ghost" });
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("COLLECTION_NOT_FOUND");
	});

	it("duplicate name+locale is CONFLICT, not a 500-shaped *_ERROR", async () => {
		const first = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(first.success).toBe(true);
		const second = await handleRelationCreate(ctx.db, { ...baseInput });
		expect(second.success).toBe(false);
		if (second.success) return;
		expect(second.error.code).toBe("CONFLICT");
	});

	it("a bogus translationOf is NOT_FOUND", async () => {
		const result = await handleRelationCreate(ctx.db, {
			...baseInput,
			locale: "fr",
			translationOf: "does-not-exist",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("a second translation for an existing locale is CONFLICT", async () => {
		const en = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!en.success) return;
		const fr = await handleRelationCreate(ctx.db, {
			...baseInput,
			locale: "fr",
			translationOf: en.data.relation.id,
		});
		expect(fr.success).toBe(true);
		// A second fr translation collides on (translation_group, locale).
		const dup = await handleRelationCreate(ctx.db, {
			...baseInput,
			locale: "fr",
			translationOf: en.data.relation.id,
		});
		expect(dup.success).toBe(false);
		if (dup.success) return;
		expect(dup.error.code).toBe("CONFLICT");
	});

	it("translations returns every locale sibling for the group", async () => {
		const en = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!en.success) return;
		await handleRelationCreate(ctx.db, {
			...baseInput,
			locale: "fr",
			parentLabel: "Responsable",
			childLabel: "Subordonné",
			translationOf: en.data.relation.id,
		});

		const result = await handleRelationTranslations(ctx.db, en.data.relation.id);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.translations.map((t) => t.locale)).toEqual(["en", "fr"]);
	});
});

function userAt(role: RoleLevel) {
	return { id: "u", role };
}

function ctxFor(
	db: unknown,
	user: { id: string; role: RoleLevel },
	init?: { method?: string; body?: unknown },
): APIContext {
	const url = new URL("http://localhost/_emdash/api/relations");
	const request = new Request(url, {
		method: init?.method ?? "GET",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: init?.body ? JSON.stringify(init.body) : undefined,
	});
	return { params: {}, url, request, locals: { emdash: { db }, user } } as unknown as APIContext;
}

describeEachDialect("relations routes (auth)", (dialect) => {
	let ctx: DialectTestContext;
	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("GET list requires schema:read (EDITOR)", async () => {
		const denied = await listRelations(ctxFor(ctx.db, userAt(Role.AUTHOR as RoleLevel)));
		expect(denied.status).toBe(403);
		const ok = await listRelations(ctxFor(ctx.db, userAt(Role.EDITOR as RoleLevel)));
		expect(ok.status).toBe(200);
	});

	it("POST create requires schema:manage (ADMIN)", async () => {
		const body = { ...baseInput };
		const denied = await createRelation(
			ctxFor(ctx.db, userAt(Role.EDITOR as RoleLevel), { method: "POST", body }),
		);
		expect(denied.status).toBe(403);
		const ok = await createRelation(
			ctxFor(ctx.db, userAt(Role.ADMIN as RoleLevel), { method: "POST", body }),
		);
		expect(ok.status).toBe(201);
	});

	it("PATCH with an empty body is a 400, not a silent 200 no-op", async () => {
		const created = await handleRelationCreate(ctx.db, { ...baseInput });
		if (!created.success) return;
		const id = created.data.relation.id;

		const url = new URL(`http://localhost/_emdash/api/relations/${id}`);
		const request = new Request(url, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({}),
		});
		const res = await patchRelation({
			params: { id },
			url,
			request,
			locals: { emdash: { db: ctx.db }, user: userAt(Role.ADMIN as RoleLevel) },
		} as unknown as APIContext);
		expect(res.status).toBe(400);
	});
});
