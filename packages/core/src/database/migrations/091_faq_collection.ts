import type { Kysely } from "kysely";

import { SchemaRegistry } from "../../schema/registry.js";
import type { Database } from "../types.js";

const FAQ_COLLECTION = {
	slug: "faqs",
	label: "FAQs",
	labelSingular: "FAQ",
	description: "Frequently asked questions managed from the CMS.",
	supports: ["drafts", "revisions", "search"] as const,
	admin: { listColumns: ["question", "sort_order"] },
};

const FAQ_FIELDS = [
	{
		slug: "question",
		label: "Question",
		type: "string" as const,
		required: true,
		searchable: true,
	},
	{
		slug: "answer",
		label: "Answer",
		type: "portableText" as const,
		required: true,
		searchable: true,
	},
	{
		slug: "sort_order",
		label: "Display order",
		type: "integer" as const,
		required: true,
		defaultValue: 0,
		indexed: true,
	},
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- migrations receive an untyped Kysely instance
	const database = db as Kysely<Database>;
	const registry = new SchemaRegistry(database);
	const existing = await registry.getCollection(FAQ_COLLECTION.slug);
	const titleFieldMissing = !existing?.titleField;

	if (!existing) {
		await registry.createCollection({
			...FAQ_COLLECTION,
			source: "manual",
			routable: false,
			hasSeo: false,
			commentsEnabled: false,
		});
	}

	for (const field of FAQ_FIELDS) {
		if (!(await registry.getField(FAQ_COLLECTION.slug, field.slug))) {
			await registry.createField(FAQ_COLLECTION.slug, field);
		}
	}

	const questionField = await registry.getField(FAQ_COLLECTION.slug, "question");
	if (
		titleFieldMissing &&
		questionField &&
		(questionField.type === "string" ||
			questionField.type === "text" ||
			questionField.type === "slug")
	) {
		await registry.updateCollection(FAQ_COLLECTION.slug, { titleField: "question" });
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Keep the built-in collection and its content when rolling back code.
}
