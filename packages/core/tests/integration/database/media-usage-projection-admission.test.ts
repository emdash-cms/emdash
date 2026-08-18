import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	MediaUsageRepository,
	type MediaUsageOccurrenceInput,
	type MediaUsageSourceInput,
} from "../../../src/database/repositories/media-usage.js";
import {
	createContentMediaUsageAdmissionBudget,
	MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS,
	planContentMediaUsageProjectionAdmission,
} from "../../../src/media/usage/content-refresh.js";
import type { ContentMediaUsageSnapshot } from "../../../src/media/usage/content-snapshots.js";
import { buildMediaUsageProjectionFingerprint } from "../../../src/media/usage/projection-fingerprint.js";
import {
	buildContentMediaUsageSourceKey,
	type MediaUsageContentSourceVariant,
} from "../../../src/media/usage/source-key.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const COLLECTION_ID = "collection-admission";
const COLLECTION_SLUG = "admission";
const EXTRACTION_FIELDS = [{ slug: "gallery", type: "image" as const }];

describeEachDialect("content media usage projection admission", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaUsageRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaUsageRepository(ctx.db);
		await ctx.db
			.insertInto("_emdash_collections")
			.values({ id: COLLECTION_ID, slug: COLLECTION_SLUG, label: "Admission" })
			.execute();
		await sql`
			CREATE TABLE ${sql.ref("ec_admission")} (
				id TEXT PRIMARY KEY,
				version INTEGER NOT NULL,
				updated_at TEXT NOT NULL,
				live_revision_id TEXT,
				draft_revision_id TEXT
			)
		`.execute(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("admits a whole entry only when the combined variant plan fits", async () => {
		const withinBudget = await plan([
			await snapshot("combined-12", "columns", 6),
			await snapshot("combined-12", "draft_overlay", 6),
		]);
		const overBudget = await plan([
			await snapshot("combined-13", "columns", 6),
			await snapshot("combined-13", "draft_overlay", 7),
		]);

		expect(withinBudget.outcome).toBe("admitted");
		expect(overBudget.outcome).toBe("intrinsic_resource_limit");
	});

	it("recomputes an oversized mixed plan after proving its replacement is unchanged", async () => {
		const contentId = "mixed-no-op-delete";
		await insertContentIdentity(ctx, contentId, true);
		const unchangedColumns = await snapshot(contentId, "columns", 0, "é".repeat(270_000));
		const absentDraft = await snapshot(contentId, "draft_overlay", 1, "Small draft");
		await repo.replaceSource(unchangedColumns.source, unchangedColumns.occurrences);
		await repo.replaceSource(absentDraft.source, absentDraft.occurrences);
		const observedSources = await repo.findSources(canonicalSourceKeys(contentId));
		const budget = createContentMediaUsageAdmissionBudget();

		const result = await planContentMediaUsageProjectionAdmission(
			repo,
			[unchangedColumns],
			observedSources,
			canonicalSourceKeys(contentId),
			budget,
		);

		expect(result.outcome).toBe("admitted");
		if (result.outcome !== "admitted") throw new Error(result.outcome);
		expect(result.noOpSourceKeys).toEqual(new Set([unchangedColumns.source.sourceKey]));
		expect(result.absentSources.map((source) => source.sourceKey)).toEqual([
			absentDraft.source.sourceKey,
		]);
		expect(result.occurrenceMutationUnits).toBe(1);
		expect(budget.remainingOccurrenceMutationUnits).toBe(
			MEDIA_USAGE_PROJECTION_ADMISSION_LIMITS.maxOccurrenceMutationUnitsPerClaim - 1,
		);
	});

	it("rejects deletion when the stored source row alone exceeds the byte limit", async () => {
		const contentId = "oversized-source-delete";
		await insertContentIdentity(ctx, contentId, true);
		const absentDraft = await snapshot(contentId, "draft_overlay", 0, "é".repeat(300_000));
		await repo.replaceSource(absentDraft.source, []);
		const observedSources = await repo.findSources(canonicalSourceKeys(contentId));
		const budget = createContentMediaUsageAdmissionBudget();

		const result = await planContentMediaUsageProjectionAdmission(
			repo,
			[],
			observedSources,
			canonicalSourceKeys(contentId),
			budget,
		);

		expect(result.outcome).toBe("intrinsic_resource_limit");
		expect(budget.hasReservedMutation).toBe(false);
	});

	it("reserves one claim budget and defers later intrinsic excess as a conflict", async () => {
		const budget = createContentMediaUsageAdmissionBudget();
		const first = await planContentMediaUsageProjectionAdmission(
			repo,
			[await snapshot("reserved-small", "columns", 1)],
			new Map(),
			canonicalSourceKeys("reserved-small"),
			budget,
		);
		const oversized = [await snapshot("reserved-large", "columns", 13)];
		const deferred = await planContentMediaUsageProjectionAdmission(
			repo,
			oversized,
			new Map(),
			canonicalSourceKeys("reserved-large"),
			budget,
		);
		const freshClaim = await planContentMediaUsageProjectionAdmission(
			repo,
			oversized,
			new Map(),
			canonicalSourceKeys("reserved-large"),
			createContentMediaUsageAdmissionBudget(),
		);

		expect(first.outcome).toBe("admitted");
		expect(budget.hasReservedMutation).toBe(true);
		expect(budget.remainingOccurrenceMutationUnits).toBe(11);
		expect(deferred.outcome).toBe("claim_budget_deferred");
		expect(freshClaim.outcome).toBe("intrinsic_resource_limit");
	});

	async function plan(snapshots: readonly ContentMediaUsageSnapshot[]) {
		const contentId = snapshots[0]?.source.contentId;
		if (!contentId) throw new Error("Expected a content identity");
		return planContentMediaUsageProjectionAdmission(
			repo,
			snapshots,
			new Map(),
			canonicalSourceKeys(contentId),
			createContentMediaUsageAdmissionBudget(),
		);
	}
});

async function insertContentIdentity(
	ctx: DialectTestContext,
	contentId: string,
	withDraft: boolean,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref("ec_admission")} (
			id, version, updated_at, live_revision_id, draft_revision_id
		) VALUES (
			${contentId},
			1,
			'2026-08-11T00:00:00.000Z',
			NULL,
			${withDraft ? `revision-${contentId}` : null}
		)
	`.execute(ctx.db);
}

async function snapshot(
	contentId: string,
	sourceVariant: MediaUsageContentSourceVariant,
	occurrenceCount: number,
	contentTitle = contentId,
): Promise<ContentMediaUsageSnapshot> {
	const source: MediaUsageSourceInput = {
		sourceKey: buildContentMediaUsageSourceKey({
			collectionId: COLLECTION_ID,
			collectionSlug: COLLECTION_SLUG,
			contentId,
			sourceVariant,
		}),
		sourceType: "content",
		collectionId: COLLECTION_ID,
		collectionSlug: COLLECTION_SLUG,
		contentId,
		sourceVariant,
		locale: "en",
		translationGroup: `translation-${contentId}`,
		contentSlug: contentId,
		contentTitle,
		contentStatus: sourceVariant === "columns" ? "published" : "draft",
		contentScheduledAt: null,
		contentDeletedAt: null,
		revisionId: sourceVariant === "draft_overlay" ? `revision-${contentId}` : null,
		schemaVersion: 1,
		sourceUpdatedAt: "2026-08-11T00:00:00.000Z",
		sourceVersion: 1,
		identityVersion: 1,
	};
	const occurrences = Array.from({ length: occurrenceCount }, (_, index) => occurrence(index));
	const projection = await buildMediaUsageProjectionFingerprint({
		collectionId: COLLECTION_ID,
		source,
		occurrences,
		extractionFields: EXTRACTION_FIELDS,
	});
	source.sourceFingerprint = projection.fingerprint;
	return {
		source,
		occurrences,
		fields: EXTRACTION_FIELDS,
		projectionByteLength: projection.byteLength,
	};
}

function occurrence(index: number): MediaUsageOccurrenceInput {
	return {
		fieldSlug: "gallery",
		fieldPath: `gallery[${index}]`,
		occurrenceIndex: index,
		referenceType: "image_field",
		mediaId: `media-${index}`,
		provider: "local",
		providerAssetId: `media-${index}`,
		mediaKind: "image",
		mimeType: "image/webp",
	};
}

function canonicalSourceKeys(contentId: string): string[] {
	return (["columns", "draft_overlay"] as const).map((sourceVariant) =>
		buildContentMediaUsageSourceKey({
			collectionId: COLLECTION_ID,
			collectionSlug: COLLECTION_SLUG,
			contentId,
			sourceVariant,
		}),
	);
}
