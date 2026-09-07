import { sql, type Kysely } from "kysely";

import type { Database } from "../../src/database/types.js";
import { installMediaUsageCaptureTriggers } from "../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

export interface MediaUsageAdmissionFixture {
	collectionId: string;
	collectionSlug: string;
	tableName: string;
}

export async function createMediaUsageAdmissionFixture(
	db: Kysely<Database>,
	collectionSlug: string,
): Promise<MediaUsageAdmissionFixture> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: collectionSlug, label: "Admission measurement" });
	await registry.createField(collectionSlug, { slug: "title", label: "Title", type: "string" });
	await registry.createField(collectionSlug, {
		slug: "body",
		label: "Body",
		type: "portableText",
	});
	await registry.createField(collectionSlug, {
		slug: "sections",
		label: "Sections",
		type: "repeater",
		validation: { subFields: [{ slug: "image", type: "image", label: "Image" }] },
	});
	const collection = await registry.getCollection(collectionSlug);
	if (!collection) throw new Error("Expected admission measurement collection");

	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({
			collection_id: collection.id,
			status: "complete",
			completed_at: "2026-08-11T00:00:00.000Z",
			reconciliation_required: 0,
			capture_state: "installing",
		})
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.where("scope_key", "=", collectionSlug)
		.execute();
	await installMediaUsageCaptureTriggers(db, {
		collectionId: collection.id,
		collectionSlug,
	});
	await db
		.updateTable("_emdash_media_usage_index_status")
		.set({ capture_state: "active" })
		.where("collection_id", "=", collection.id)
		.execute();
	await db
		.updateTable("_emdash_media_usage_activation")
		.set({ state: "active", activated_at: "2026-08-11T00:00:00.000Z" })
		.execute();

	return {
		collectionId: collection.id,
		collectionSlug,
		tableName: `ec_${collectionSlug}`,
	};
}

export async function insertMediaUsageMeasurementEntry(
	db: Kysely<Database>,
	fixture: MediaUsageAdmissionFixture,
	contentId: string,
	data: ReturnType<typeof mediaUsageMeasurementData>,
	title = contentId,
): Promise<void> {
	await sql`
		INSERT INTO ${sql.ref(fixture.tableName)} (id, slug, status, title, body, sections)
		VALUES (
			${contentId},
			${contentId},
			'published',
			${title},
			${JSON.stringify(data.body)},
			${JSON.stringify(data.sections)}
		)
	`.execute(db);
}

export async function addMediaUsageMeasurementDraft(
	db: Kysely<Database>,
	fixture: MediaUsageAdmissionFixture,
	contentId: string,
	data: ReturnType<typeof mediaUsageMeasurementData>,
): Promise<void> {
	const revisionId = `revision-${contentId}`;
	await db
		.insertInto("revisions")
		.values({
			id: revisionId,
			collection: fixture.collectionSlug,
			entry_id: contentId,
			data: JSON.stringify(data),
			author_id: null,
		})
		.execute();
	await sql`
		UPDATE ${sql.ref(fixture.tableName)}
		SET draft_revision_id = ${revisionId}
		WHERE id = ${contentId}
	`.execute(db);
}

export function mediaUsageMeasurementData(count: number, prefix: string) {
	const portableTextCount = Math.ceil(count / 2);
	const repeaterCount = Math.floor(count / 2);
	return {
		body: Array.from({ length: portableTextCount }, (_, index) => ({
			_type: "image",
			_key: `body-${index}`,
			asset: { _ref: `${prefix}-body-${index}` },
		})),
		sections: Array.from({ length: repeaterCount }, (_, index) => ({
			_key: `section-${index}`,
			image: {
				id: `${prefix}-section-${index}`,
				provider: "local",
				mimeType: "image/webp",
			},
		})),
	};
}
