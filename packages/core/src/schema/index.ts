export { SchemaRegistry, SchemaError } from "./registry.js";
export { BlockTypeRegistry } from "./block-type-registry.js";
export {
	canonicalBlockFields,
	compareBlockFields,
	fingerprintBlockFields,
	validateBlockFields,
} from "./block-type-contract.js";
export { BLOCK_FIELD_TYPES } from "./block-types.js";
export {
	expandCollectionBlockFields,
	normalizeBlocksData,
	resolveBlockTypes,
} from "./block-values.js";
export type { BlockWriteOptions, ResolvedBlockTypes, StoredBlockValue } from "./block-values.js";
export type {
	BlockFieldDefinition,
	BlockFieldOptions,
	BlockFieldType,
	BlockType,
	BlockTypeCompatibility,
	BlockTypeDifference,
	BlockTypeSource,
	BlockTypeVersion,
	CreateBlockTypeInput,
	UpdateBlockTypeInput,
	ApplySeedBlockTypeInput,
	SeedBlockTypeVersionInput,
} from "./block-types.js";
export type {
	FieldType,
	ColumnType,
	CollectionSupport,
	CollectionSource,
	FieldValidation,
	FieldWidgetOptions,
	UnsupportedFieldType,
	Collection,
	Field,
	CreateCollectionInput,
	UpdateCollectionInput,
	CreateFieldInput,
	UpdateFieldInput,
	CollectionWithFields,
} from "./types.js";
export { FIELD_TYPE_TO_COLUMN, RESERVED_FIELD_SLUGS, RESERVED_COLLECTION_SLUGS } from "./types.js";

export { getCollectionInfo, getCollectionInfoWithDb } from "./query.js";

export {
	generateZodSchema,
	generateFieldSchema,
	getCachedSchema,
	invalidateSchemaCache,
	clearSchemaCache,
	validateContent,
	generateTypeScript,
} from "./zod-generator.js";
