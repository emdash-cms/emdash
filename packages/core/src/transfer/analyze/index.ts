export type { IssueState } from "./issues.js";

export type { PlanInputs, PlanOrigin, PlanTarget, PrincipalBylines } from "./plan.js";
export { applyDecisions, buildBlockedPlan, buildPlan, defaultDecisions } from "./plan.js";

export type { AnalyzeImportStepInput, AnalyzeImportStepResult, FinalizePlanInput } from "./step.js";
export { analyzeImportStep, finalizePlan, loadImportPlan } from "./step.js";

export type { AnalysisTargetContext, DomainFindings } from "./target.js";
export {
	analysisTargetContext,
	checkLocales,
	findMissingUsers,
	findRedirectLoops,
	inspectTargetDomain,
	MAX_LOOP_CHECKED_REDIRECTS,
	suggestPrincipalUsers,
} from "./target.js";

export type {
	PrincipalSummary,
	ValidateStagedPackageInput,
	ValidationOptions,
	ValidationPhase,
	ValidationState,
	ValidationStepResult,
	ValidationSummary,
	ValidationTarget,
} from "./validate.js";
export {
	initialValidationState,
	parseValidationState,
	runValidationStep,
	summarizeValidation,
	validateStagedPackage,
	validateStagedPackageStep,
	VALIDATION_PHASES,
	validationStateSchema,
} from "./validate.js";

export type { FieldInfo, RecordScan, TargetDialect } from "./values.js";
export { checkEntryFields, checkRecordNumbers, scanRecordValues } from "./values.js";

export type { KeyedRecord, UniqueCollision, UniqueConstraint, UniqueKey } from "./unique-keys.js";
export { findUniqueCollisions, UNIQUE_CONSTRAINTS, uniqueKeysOf } from "./unique-keys.js";
