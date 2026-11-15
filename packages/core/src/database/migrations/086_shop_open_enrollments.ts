import { type Kysely } from "kysely";
import { ulid } from "ulidx";

import { columnExists, currentTimestamp, tableExists } from "../dialect-helpers.js";
import type { Database } from "../types.js";

const REGISTRATION_MODE_FIELD = {
	slug: "registration_mode",
	label: "Tipo de inscripción",
	type: "select",
	columnType: "text" as const,
	validation: { options: ["scheduled", "open_enrollment"] },
} as const;

export async function up(db: Kysely<unknown>): Promise<void> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- migrations receive an untyped Kysely instance
	const database = db as Kysely<Database>;
	const services = await database
		.selectFrom("_emdash_collections")
		.select(["id"])
		.where("slug", "=", "services")
		.executeTakeFirst();

	if (services && (await tableExists(database, "ec_services"))) {
		if (!(await columnExists(database, "ec_services", REGISTRATION_MODE_FIELD.slug))) {
			await database.schema
				.alterTable("ec_services")
				.addColumn(REGISTRATION_MODE_FIELD.slug, "text", (column) =>
					column.notNull().defaultTo("scheduled"),
				)
				.execute();
		}

		const existing = await database
			.selectFrom("_emdash_fields")
			.select(["id"])
			.where("collection_id", "=", services.id)
			.where("slug", "=", REGISTRATION_MODE_FIELD.slug)
			.executeTakeFirst();
		if (!existing) {
			const maxSort = await database
				.selectFrom("_emdash_fields")
				.select(({ fn }) => fn.max<number>("sort_order").as("max"))
				.where("collection_id", "=", services.id)
				.executeTakeFirst();
			await database
				.insertInto("_emdash_fields")
				.values({
					id: ulid(),
					collection_id: services.id,
					slug: REGISTRATION_MODE_FIELD.slug,
					label: REGISTRATION_MODE_FIELD.label,
					type: REGISTRATION_MODE_FIELD.type,
					column_type: "TEXT",
					required: 0,
					unique: 0,
					default_value: "scheduled",
					validation: JSON.stringify(REGISTRATION_MODE_FIELD.validation),
					widget: null,
					options: null,
					sort_order: (maxSort?.max ?? -1) + 1,
					searchable: 0,
					indexed: 0,
					translatable: 1,
				})
				.execute();
		}
	}

	await database.schema
		.createTable("_emdash_shop_enrollments")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("service_id", "text", (column) => column.notNull())
		.addColumn("order_id", "text")
		.addColumn("order_item_id", "text")
		.addColumn("customer_id", "text")
		.addColumn("quantity", "integer", (column) => column.notNull().defaultTo(1))
		.addColumn("starts_at", "text")
		.addColumn("ends_at", "text")
		.addColumn("status", "text", (column) => column.notNull().defaultTo("pending_schedule"))
		.addColumn("customer_snapshot", "text")
		.addColumn("service_snapshot", "text")
		.addColumn("notes", "text")
		.addColumn("created_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.execute();

	await database.schema
		.createIndex("idx_shop_enrollments_service_status")
		.ifNotExists()
		.on("_emdash_shop_enrollments")
		.columns(["service_id", "status"])
		.execute();
	await database.schema
		.createIndex("idx_shop_enrollments_order")
		.ifNotExists()
		.on("_emdash_shop_enrollments")
		.columns(["order_id", "order_item_id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_shop_enrollments").ifExists().execute();
}
