export type { TransferErrorDetail } from "./errors.js";
export {
	isTransferError,
	isTransferErrorCode,
	TRANSFER_ERROR_STATUS,
	TransferError,
	TransferErrorCode,
	transferErrorDetailSchema,
	transferErrorStatus,
} from "./errors.js";

export type { TransferAction, TransferApprovalAction, TransferScope } from "./auth.js";
export {
	isTransferScope,
	TRANSFER_ACTION_PERMISSION,
	TRANSFER_ACTION_SCOPE,
	TRANSFER_APPROVAL_ACTIONS,
	TRANSFER_SCOPES,
} from "./auth.js";

export type { JsonPrimitive, JsonValue } from "./format/canonical.js";
export {
	canonicalJson,
	CanonicalJsonError,
	compareUtf16,
	measureJsonDepth,
	parseCanonicalJson,
} from "./format/canonical.js";

export type { Sha256Backend, Sha256Digest, Sha256Hasher } from "./format/digest.js";
export {
	availableSha256Backends,
	canonicalDigest,
	chunkLogicalSha256,
	createHashingStream,
	createSha256,
	isSha256Digest,
	isSha256Hex,
	logicalDigest,
	packageDigest,
	planDigest,
	receiptDigest,
	recordSha256,
	sha256Hex,
	sha256HexOf,
	toSha256Digest,
} from "./format/digest.js";

export type { SitePackageFeature } from "./format/features.js";
export {
	isSitePackageFeature,
	KIND_FEATURE,
	OPTIONAL_FEATURES,
	requiredFeaturesFor,
	SITE_PACKAGE_FEATURES,
	unsupportedRequiredFeatures,
} from "./format/features.js";

export type {
	BylineFieldGroupValueRecord,
	BylineFieldRecord,
	BylineFieldValueRecord,
	BylineRecord,
	CollectionRecord,
	CommentReactionRecord,
	CommentRecord,
	ContentBylineRecord,
	ContentReferenceRecord,
	ContentTermRecord,
	EntryRecord,
	FieldRecord,
	ImportRecordStage,
	KindReference,
	MediaFolderRecord,
	MediaRecord,
	MenuItemRecord,
	MenuRecord,
	PrincipalRecord,
	RecordKind,
	RecordOfKind,
	RecordValidationIssue,
	RecordValidationResult,
	RedirectRecord,
	ReferenceKey,
	RelationRecord,
	RevisionRecord,
	SectionRecord,
	SeoRecord,
	SettingRecord,
	SitePackageRecord,
	StreamOrder,
	StreamOrderKey,
	SyntheticIdKind,
	TaxonomyDefRecord,
	TermRecord,
	TopologicalKind,
	WidgetAreaRecord,
	WidgetRecord,
} from "./format/kinds.js";
export {
	compareIds,
	compareStreamOrder,
	identifierSchema,
	identityProperties,
	IMPORT_RECORD_STAGES,
	IMPORT_STAGE_KINDS,
	inferredCreditId,
	isRecordKind,
	isRecordOfKind,
	KIND_REFERENCES,
	NON_IMPORTED_KINDS,
	portableIdSchema,
	RECORD_KINDS,
	RECORD_SCHEMAS,
	recordKindIndex,
	sitePackageRecordSchema,
	streamOrderOf,
	SYNTHETIC_ID_KINDS,
	syntheticId,
	TOPOLOGICAL_PARENT_PROPERTY,
	validateRecord,
} from "./format/kinds.js";

export type {
	ColumnClass,
	ColumnCodec,
	ColumnSpec,
	PortableTableSpec,
	TableClass,
} from "./format/columns.js";
export {
	assertColumnCoverage,
	classifyTable,
	codecForColumnType,
	CONTENT_TABLE_COLUMNS,
	CONTENT_TABLE_PREFIX,
	getColumnSpecs,
	getPortableTableSpec,
	getPortableTableSpecForKind,
	isContentTableName,
	listUnclassifiedColumns,
	NON_PORTABLE_TABLE_PREFIXES,
	NON_PORTABLE_TABLES,
	PORTABLE_TABLES,
} from "./format/columns.js";

export {
	decodeColumn,
	decodeContentRow,
	decodeRow,
	encodeColumn,
	encodeContentRow,
	encodeRow,
	isContentFieldColumn,
	selectColumn,
	selectExportedColumns,
} from "./format/column-codec.js";

export type { TransferLimits } from "./format/limits.js";
export { rowsPerInsert, TRANSFER_LIMITS } from "./format/limits.js";

export type { IndexChunkRef, PackageFileEntry, SitePackageManifest } from "./format/manifest.js";
export {
	indexChunkRefSchema,
	packageFileEntrySchema,
	parseIndexLine,
	parseManifest,
	serializeManifest,
	sitePackageManifestSchema,
} from "./format/manifest.js";

export type {
	MediaKeyIndex,
	MediaRefIssue,
	MediaRefIssueCode,
	MediaRefMode,
	RewriteMediaRefsOptions,
	RewriteMediaRefsResult,
} from "./format/media-refs.js";
export {
	buildMediaKeyIndex,
	canUsePlaceholder,
	MEDIA_FILE_PATH,
	MEDIA_PLACEHOLDER_PREFIX,
	mediaPlaceholder,
	parseMediaPlaceholder,
	rewriteMediaRefs,
	scanForKeys,
	scannableKeys,
} from "./format/media-refs.js";

export type { PackagePath } from "./format/paths.js";
export {
	indexChunkPath,
	isPackagePath,
	MANIFEST_PATH,
	mediaBlobPath,
	parsePackagePath,
	recordChunkPath,
} from "./format/paths.js";

export type {
	PlanBlocker,
	PlanBlockerCode,
	PlanPrincipal,
	PlanWarning,
	PlanWarningCode,
	SiteImportDecisions,
	SiteImportDecisionsInput,
	SiteImportPlan,
} from "./format/plan.js";
export {
	isPlanExecutable,
	mergeDecisions,
	PLAN_BLOCKER_CODES,
	PLAN_WARNING_CODES,
	planBlockerSchema,
	planPrincipalSchema,
	planWarningSchema,
	SETTING_CHOICES,
	siteImportDecisionsInputSchema,
	siteImportDecisionsSchema,
	siteImportPlanSchema,
} from "./format/plan.js";

export type { SiteImportReceipt, UnsignedSiteImportReceipt } from "./format/receipt.js";
export { sealReceipt, siteImportReceiptSchema, verifyReceiptDigest } from "./format/receipt.js";

export type { DecodedRecord } from "./format/records.js";
export {
	decodeRecordLine,
	encodeChunk,
	encodeRecordLine,
	splitChunkLines,
} from "./format/records.js";

export type { PortableSettingName, SettingClass } from "./format/settings.js";
export {
	classifySetting,
	DECIDED_SETTING_NAMES,
	isPortableSettingName,
	PORTABLE_SETTING_NAMES,
	POST_IMPORT_OPTION_RESETS,
	SETTING_MEDIA_REFERENCE_PATHS,
	settingMediaIds,
} from "./format/settings.js";

export type {
	ExportTransformation,
	ExportTransformationCode,
	FieldColumnType,
	ImportTransformation,
	ImportTransformationCode,
	PlanTransformation,
	TransformationContext,
	TransformationPlan,
} from "./format/transformations.js";
export {
	applyTransformations,
	EXPORT_TRANSFORMATION_CODES,
	exportTransformationSchema,
	IMPORT_TRANSFORMATION_CODES,
	importTransformationSchema,
	planTransformationSchema,
} from "./format/transformations.js";

export type { SitePackageFormatVersion } from "./format/version.js";
export {
	SITE_PACKAGE_FORMAT,
	SITE_PACKAGE_FORMAT_VERSION,
	SITE_PACKAGE_PROFILE,
	SUPPORTED_FORMAT_VERSIONS,
} from "./format/version.js";

export type {
	AnalysisCursor,
	AnalysisStage,
	ExportCursor,
	ExportFence,
	ExportStage,
	ExportState,
	ImportCursor,
	ImportStage,
	ImportState,
	RebuildStep,
	StreamPosition,
	TransferCursor,
	TransferOperationKind,
	TransferOperationState,
	TransferProgress,
} from "./ops/states.js";
export {
	ANALYSIS_STAGES,
	analysisCursorSchema,
	EXECUTING_IMPORT_STATES,
	EXPORT_STAGES,
	EXPORT_STATES,
	exportCursorSchema,
	exportFenceSchema,
	IMPORT_STAGES,
	IMPORT_STATES,
	importCursorSchema,
	isOccupyingImport,
	isTerminalState,
	isTransferOperationKind,
	isTransferOperationState,
	isWriteFencingImport,
	PRE_EXECUTION_IMPORT_STATES,
	REBUILD_STEPS,
	streamKeySchema,
	streamPositionSchema,
	TERMINAL_EXPORT_STATES,
	TERMINAL_IMPORT_STATES,
	TRANSFER_OPERATION_KINDS,
	TRANSFER_RUNTIME_GENERATION,
	transferCursorSchema,
	transferProgressSchema,
} from "./ops/states.js";

export type {
	ClaimResult,
	CreateTransferOperationInput,
	OperationPatch,
	PublicTransferOperation,
	TransferOperation,
} from "./ops/operations.js";
export {
	createStagingSecret,
	toPublicOperation,
	TransferOperationRepository,
} from "./ops/operations.js";

export type { IdentityMapping } from "./ops/identity-map.js";
export { MEDIA_STORAGE_KEY_ENTITY, TransferIdentityMapRepository } from "./ops/identity-map.js";

export type { DeclaredFile, StagedFile, StagedFileState } from "./ops/staged-files.js";
export { TransferStagedFileRepository } from "./ops/staged-files.js";

export type { PackageIndexEntry } from "./ops/package-index.js";
export { TransferPackageIndexRepository } from "./ops/package-index.js";

export type { MediaBlobEntry } from "./ops/media-blobs.js";
export { TransferMediaBlobRepository } from "./ops/media-blobs.js";

export type { ApprovalBinding, ApprovalStatus, TransferApproval } from "./ops/approvals.js";
export { APPROVAL_STATUSES, TransferApprovalRepository } from "./ops/approvals.js";

export type { StepBudget, StepBudgetOptions } from "./ops/budget.js";
export { TransferStepBudget } from "./ops/budget.js";

export { bytewise, likePrefix } from "./ops/collation.js";
export {
	timestampIsDue,
	timestampIsLive,
	timestampIsOlderThan,
	timestampNow,
	timestampOffset,
} from "./ops/time.js";

export type { StagingAuxFile } from "./staging/keys.js";
export {
	isRefusedStorageKey,
	isTransferStorageKey,
	normalizeStorageKeyForGuard,
	PRIVATE_STORAGE_PREFIXES,
	STAGING_AUX_FILES,
	stagingAuxKey,
	stagingKey,
	stagingPrefix,
	TRANSFER_STORAGE_PREFIX,
} from "./staging/keys.js";

export type { ExpectedFile, PutVerifiedOptions } from "./staging/stage.js";
export { putVerified, readStreamBytes, TransferStage } from "./staging/stage.js";

export type { StagedRecord } from "./staging/package.js";
export { StagedPackageReader, StagedPackageWriter } from "./staging/package.js";

export type { AssembledPackage, PackageMetadata } from "./staging/assembler.js";
export { PackageAssembler } from "./staging/assembler.js";

export type { PackageFileSource, UnpackedPackageFile, UnpackOptions } from "./container/tar.js";
export {
	packSitePackage,
	readSitePackageArchive,
	SITE_PACKAGE_FILE_EXTENSION,
	SITE_PACKAGE_MEDIA_TYPE,
	unpackSitePackage,
} from "./container/tar.js";

export type {
	SiteWriteFenceCode,
	SiteWriteFenceError,
	SiteWriteFenceScope,
	SiteWriteFenceStatus,
	RecordSiteWrite,
} from "./fence.js";
export {
	assertSiteWriteAllowed,
	checkSiteWriteFence,
	findSiteWriteFenceError,
	readSiteWriteFence,
	recordSiteWrite,
	SiteWriteBlockedError,
} from "./fence.js";

export type { DomainBlocker, PortableDomainInspection, ScaffoldItem } from "./domain.js";
export { inspectPortableDomain } from "./domain.js";

export { getOrCreateSiteId, SITE_ID_OPTION } from "./site-id.js";

export type { TransferStagingCollectionOptions, TransferStagingCollectionResult } from "./gc.js";
export { collectTransferStaging, IMPORT_STAGING_RETENTION_SECONDS } from "./gc.js";

export type {
	CollectionImporter,
	ImportCollectionOptions,
	ImportCollectionResult,
} from "./schema-importer.js";

export type {
	AdvanceExportInput,
	AdvanceExportOutcome,
	AdvanceExportResult,
	CreateExportInput,
	ExportOptions,
	ExportPackageValidator,
	ExportPackageValidatorInput,
	ExportPackageValidatorResult,
} from "./export/exporter.js";
export {
	advanceExport,
	createExport,
	ExportPackageReader,
	exportOptionsSchema,
	openExportPackage,
} from "./export/exporter.js";

export type {
	KindReader,
	ReadAdjustment,
	ReaderOptions,
	ReadPage,
	ReadRow,
} from "./export/readers.js";
export { createReader } from "./export/readers.js";

export type {
	VerificationMismatch,
	VerifyImportStepInput,
	VerifyImportStepResult,
} from "./export/verify.js";
export { verifyImportStep } from "./export/verify.js";

export type {
	AnalysisTargetContext,
	AnalyzeImportStepInput,
	AnalyzeImportStepResult,
	FinalizePlanInput,
	ValidateStagedPackageInput,
	ValidationOptions,
	ValidationStepResult,
	ValidationTarget,
} from "./analyze/index.js";
export {
	analysisTargetContext,
	analyzeImportStep,
	finalizePlan,
	loadImportPlan,
	validateStagedPackage,
	validateStagedPackageStep,
} from "./analyze/index.js";
