import type { CollectionRecord, FieldRecord } from "./format/kinds.js";

export interface ImportCollectionOptions {
	/**
	 * Tolerate a partially completed earlier attempt: create tables and
	 * indexes with `IF NOT EXISTS`, insert rows with `ON CONFLICT DO NOTHING`,
	 * then assert that the stored rows equal the records.
	 */
	resume: true;
}

export interface ImportCollectionResult {
	/** Whether this call created the collection row (false when resuming). */
	collectionCreated: boolean;
	fieldsCreated: number;
}

/**
 * Writes one package collection and its fields with their exact ids and
 * every column, creating the `ec_*` table and indexes the same way
 * `SchemaRegistry` does and installing media-usage capture. The collection's
 * `search_config` is written with `enabled: false`; the rebuild stage enables
 * search after content is imported. Title and date fields are set after the
 * fields exist.
 *
 * Implemented by `SchemaRegistry.importCollection`.
 */
export interface CollectionImporter {
	importCollection(
		collection: CollectionRecord,
		fields: readonly FieldRecord[],
		options: ImportCollectionOptions,
	): Promise<ImportCollectionResult>;
}
