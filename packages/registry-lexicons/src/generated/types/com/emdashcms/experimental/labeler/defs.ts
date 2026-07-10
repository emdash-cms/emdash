import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import * as ComAtprotoLabelDefs from "@atcute/atproto/types/label/defs";

const _artifactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.labeler.defs#artifact"),
	),
	/**
	 * @minLength 1
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 256),
	]),
	/**
	 * @maxLength 256
	 */
	id: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 256),
		]),
	),
});
const _assessmentSubjectSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#assessmentSubject",
		),
	),
	cid: /*#__PURE__*/ v.cidString(),
	uri: /*#__PURE__*/ v.resourceUriString(),
});
const _contactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.labeler.defs#contact"),
	),
	/**
	 * @minLength 1
	 * @maxLength 256
	 */
	reconsiderationEmail: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 256),
	]),
	/**
	 * @maxLength 2048
	 */
	reconsiderationUrl: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.genericUriString(),
		[/*#__PURE__*/ v.stringLength(0, 2048)],
	),
});
const _coverageSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.labeler.defs#coverage"),
	),
	code: /*#__PURE__*/ v.string<
		"complete" | "partial" | "unavailable" | (string & {})
	>(),
	dependencies: /*#__PURE__*/ v.string<
		"complete" | "partial" | "unavailable" | (string & {})
	>(),
	images: /*#__PURE__*/ v.string<
		"complete" | "not-present" | "partial" | "unavailable" | (string & {})
	>(),
	metadata: /*#__PURE__*/ v.string<
		"complete" | "partial" | "unavailable" | (string & {})
	>(),
});
const _currentAssessmentViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#currentAssessmentView",
		),
	),
	/**
	 * @maxLength 64
	 */
	get activeLabels() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(ComAtprotoLabelDefs.labelSchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	get current() {
		return /*#__PURE__*/ v.optional(publicAssessmentSchema);
	},
	get override() {
		return /*#__PURE__*/ v.optional(publicManualActionSchema);
	},
	get pending() {
		return /*#__PURE__*/ v.optional(publicAssessmentSchema);
	},
	src: /*#__PURE__*/ v.didString(),
	get subject() {
		return assessmentSubjectSchema;
	},
});
const _labelSummarySchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#labelSummary",
		),
	),
	active: /*#__PURE__*/ v.boolean(),
	expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
	issuedAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	val: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
});
const _labelerPolicySchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#labelerPolicy",
		),
	),
	/**
	 * @minimum 1
	 */
	assessmentSchemaVersion: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.integer(),
		[/*#__PURE__*/ v.integerRange(1)],
	),
	get contact() {
		return contactSchema;
	},
	effectiveAt: /*#__PURE__*/ v.datetimeString(),
	labelerDid: /*#__PURE__*/ v.didString(),
	/**
	 * @maxLength 256
	 */
	get labels() {
		return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(policyLabelSchema), [
			/*#__PURE__*/ v.arrayLength(0, 256),
		]);
	},
	get overrideRule() {
		return overrideRuleSchema;
	},
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	policyVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @maxLength 32
	 */
	precedence: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(1, 128),
			]),
		),
		[/*#__PURE__*/ v.arrayLength(0, 32)],
	),
	get publicApi() {
		return publicApiSchema;
	},
	/**
	 * @maxLength 256
	 */
	get reasonCodes() {
		return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(reasonCodeSchema), [
			/*#__PURE__*/ v.arrayLength(0, 256),
		]);
	},
	/**
	 * @minimum 1
	 * @maximum 1
	 */
	schemaVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
		/*#__PURE__*/ v.integerRange(1, 1),
	]),
	get supportedSubjects() {
		return supportedSubjectsSchema;
	},
	get transparency() {
		return transparencySchema;
	},
});
const _manualActionSubjectSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#manualActionSubject",
		),
	),
	cid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.cidString()),
	uri: /*#__PURE__*/ v.genericUriString(),
});
const _modelSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.labeler.defs#model"),
	),
	/**
	 * @minLength 1
	 * @maxLength 256
	 */
	modelId: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 256),
	]),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	promptVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	provider: /*#__PURE__*/ v.string<"workers-ai" | (string & {})>(),
});
const _overrideRuleSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#overrideRule",
		),
	),
	cidRule: /*#__PURE__*/ v.string<"required" | (string & {})>(),
	requireAtomicIssuance: /*#__PURE__*/ v.boolean(),
	requireSameSource: /*#__PURE__*/ v.boolean(),
	/**
	 * @minLength 1
	 * @maxLength 8
	 */
	reviewerLabels: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(1, 128),
			]),
		),
		[/*#__PURE__*/ v.arrayLength(1, 8)],
	),
	subject: /*#__PURE__*/ v.string<"release" | (string & {})>(),
});
const _policyLabelSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#policyLabel",
		),
	),
	category: /*#__PURE__*/ v.string<
		| "automated-block"
		| "eligibility"
		| "manual-system"
		| "warning"
		| (string & {})
	>(),
	/**
	 * @maxLength 64
	 */
	get locales() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(policyLocaleSchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	officialEffect: /*#__PURE__*/ v.string<
		"block" | "error" | "pass" | "pending" | "redact" | "warn" | (string & {})
	>(),
	/**
	 * @maxLength 8
	 */
	get subjectRules() {
		return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(subjectRuleSchema), [
			/*#__PURE__*/ v.arrayLength(0, 8),
		]);
	},
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	value: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
});
const _policyLocaleSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#policyLocale",
		),
	),
	/**
	 * @minLength 1
	 * @maxLength 4096
	 */
	description: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 4096),
	]),
	lang: /*#__PURE__*/ v.languageCodeString(),
	/**
	 * @minLength 1
	 * @maxLength 1024
	 */
	name: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 1024),
	]),
});
const _publicApiSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publicApi",
		),
	),
	/**
	 * @maxLength 2048
	 */
	baseUrl: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
		/*#__PURE__*/ v.stringLength(0, 2048),
	]),
	getAssessmentNsid: /*#__PURE__*/ v.nsidString(),
	getCurrentAssessmentNsid: /*#__PURE__*/ v.nsidString(),
	getPolicyNsid: /*#__PURE__*/ v.nsidString(),
	listAssessmentsNsid: /*#__PURE__*/ v.nsidString(),
	/**
	 * @maxLength 2048
	 */
	policyUrl: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
		/*#__PURE__*/ v.stringLength(0, 2048),
	]),
});
const _publicAssessmentSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publicAssessment",
		),
	),
	get artifact() {
		return /*#__PURE__*/ v.optional(artifactSchema);
	},
	/**
	 * @minimum 1
	 */
	assessmentSchemaVersion: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.integer(),
		[/*#__PURE__*/ v.integerRange(1)],
	),
	completedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
	get coverage() {
		return coverageSchema;
	},
	createdAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * @minLength 1
	 * @maxLength 64
	 */
	id: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(labelSummarySchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	get model() {
		return /*#__PURE__*/ v.optional(modelSchema);
	},
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	policyVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @maxLength 2048
	 */
	reconsiderationUrl: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.genericUriString(),
		[/*#__PURE__*/ v.stringLength(0, 2048)],
	),
	/**
	 * @maxLength 64
	 */
	get scannerVersions() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(scannerVersionSchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	src: /*#__PURE__*/ v.didString(),
	state: /*#__PURE__*/ v.string<
		| "blocked"
		| "error"
		| "passed"
		| "pending"
		| "superseded"
		| "warned"
		| (string & {})
	>(),
	get subject() {
		return assessmentSubjectSchema;
	},
	/**
	 * @minLength 1
	 * @maxLength 4096
	 */
	summary: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 4096),
	]),
	/**
	 * @minLength 1
	 * @maxLength 64
	 */
	supersedesAssessmentId: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(1, 64),
		]),
	),
});
const _publicManualActionSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publicManualAction",
		),
	),
	createdAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * @minLength 1
	 * @maxLength 64
	 */
	id: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(labelSummarySchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	src: /*#__PURE__*/ v.didString(),
	get subject() {
		return manualActionSubjectSchema;
	},
	/**
	 * @minLength 1
	 * @maxLength 4096
	 */
	summary: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 4096),
	]),
	type: /*#__PURE__*/ v.string<
		| "emergency-takedown"
		| "label-issue"
		| "label-retraction"
		| "override"
		| (string & {})
	>(),
});
const _publisherSubjectSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publisherSubject",
		),
	),
	kind: /*#__PURE__*/ v.string<"did" | (string & {})>(),
});
const _reasonCodeSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#reasonCode",
		),
	),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	code: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @minLength 1
	 * @maxLength 4096
	 */
	description: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 4096),
	]),
});
const _scannerVersionSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#scannerVersion",
		),
	),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	scanner: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	version: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
});
const _subjectRuleSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#subjectRule",
		),
	),
	cidRule: /*#__PURE__*/ v.string<
		"forbidden" | "optional" | "required" | (string & {})
	>(),
	/**
	 * @minLength 1
	 * @maxLength 3
	 */
	issuanceModes: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(
			/*#__PURE__*/ v.string<
				"admin" | "automated" | "reviewer" | (string & {})
			>(),
		),
		[/*#__PURE__*/ v.arrayLength(1, 3)],
	),
	subject: /*#__PURE__*/ v.string<
		"package" | "publisher" | "release" | (string & {})
	>(),
});
const _supportedSubjectsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#supportedSubjects",
		),
	),
	/**
	 * @maxLength 32
	 */
	packageCollections: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(/*#__PURE__*/ v.nsidString()),
		[/*#__PURE__*/ v.arrayLength(0, 32)],
	),
	get publisher() {
		return publisherSubjectSchema;
	},
	/**
	 * @maxLength 32
	 */
	releaseCollections: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(/*#__PURE__*/ v.nsidString()),
		[/*#__PURE__*/ v.arrayLength(0, 32)],
	),
});
const _transparencySchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#transparency",
		),
	),
	modelOutputIsAdvisoryEvidence: /*#__PURE__*/ v.boolean(),
});

type artifact$schematype = typeof _artifactSchema;
type assessmentSubject$schematype = typeof _assessmentSubjectSchema;
type contact$schematype = typeof _contactSchema;
type coverage$schematype = typeof _coverageSchema;
type currentAssessmentView$schematype = typeof _currentAssessmentViewSchema;
type labelSummary$schematype = typeof _labelSummarySchema;
type labelerPolicy$schematype = typeof _labelerPolicySchema;
type manualActionSubject$schematype = typeof _manualActionSubjectSchema;
type model$schematype = typeof _modelSchema;
type overrideRule$schematype = typeof _overrideRuleSchema;
type policyLabel$schematype = typeof _policyLabelSchema;
type policyLocale$schematype = typeof _policyLocaleSchema;
type publicApi$schematype = typeof _publicApiSchema;
type publicAssessment$schematype = typeof _publicAssessmentSchema;
type publicManualAction$schematype = typeof _publicManualActionSchema;
type publisherSubject$schematype = typeof _publisherSubjectSchema;
type reasonCode$schematype = typeof _reasonCodeSchema;
type scannerVersion$schematype = typeof _scannerVersionSchema;
type subjectRule$schematype = typeof _subjectRuleSchema;
type supportedSubjects$schematype = typeof _supportedSubjectsSchema;
type transparency$schematype = typeof _transparencySchema;

export interface artifactSchema extends artifact$schematype {}
export interface assessmentSubjectSchema extends assessmentSubject$schematype {}
export interface contactSchema extends contact$schematype {}
export interface coverageSchema extends coverage$schematype {}
export interface currentAssessmentViewSchema extends currentAssessmentView$schematype {}
export interface labelSummarySchema extends labelSummary$schematype {}
export interface labelerPolicySchema extends labelerPolicy$schematype {}
export interface manualActionSubjectSchema extends manualActionSubject$schematype {}
export interface modelSchema extends model$schematype {}
export interface overrideRuleSchema extends overrideRule$schematype {}
export interface policyLabelSchema extends policyLabel$schematype {}
export interface policyLocaleSchema extends policyLocale$schematype {}
export interface publicApiSchema extends publicApi$schematype {}
export interface publicAssessmentSchema extends publicAssessment$schematype {}
export interface publicManualActionSchema extends publicManualAction$schematype {}
export interface publisherSubjectSchema extends publisherSubject$schematype {}
export interface reasonCodeSchema extends reasonCode$schematype {}
export interface scannerVersionSchema extends scannerVersion$schematype {}
export interface subjectRuleSchema extends subjectRule$schematype {}
export interface supportedSubjectsSchema extends supportedSubjects$schematype {}
export interface transparencySchema extends transparency$schematype {}

export const artifactSchema = _artifactSchema as artifactSchema;
export const assessmentSubjectSchema =
	_assessmentSubjectSchema as assessmentSubjectSchema;
export const contactSchema = _contactSchema as contactSchema;
export const coverageSchema = _coverageSchema as coverageSchema;
export const currentAssessmentViewSchema =
	_currentAssessmentViewSchema as currentAssessmentViewSchema;
export const labelSummarySchema = _labelSummarySchema as labelSummarySchema;
export const labelerPolicySchema = _labelerPolicySchema as labelerPolicySchema;
export const manualActionSubjectSchema =
	_manualActionSubjectSchema as manualActionSubjectSchema;
export const modelSchema = _modelSchema as modelSchema;
export const overrideRuleSchema = _overrideRuleSchema as overrideRuleSchema;
export const policyLabelSchema = _policyLabelSchema as policyLabelSchema;
export const policyLocaleSchema = _policyLocaleSchema as policyLocaleSchema;
export const publicApiSchema = _publicApiSchema as publicApiSchema;
export const publicAssessmentSchema =
	_publicAssessmentSchema as publicAssessmentSchema;
export const publicManualActionSchema =
	_publicManualActionSchema as publicManualActionSchema;
export const publisherSubjectSchema =
	_publisherSubjectSchema as publisherSubjectSchema;
export const reasonCodeSchema = _reasonCodeSchema as reasonCodeSchema;
export const scannerVersionSchema =
	_scannerVersionSchema as scannerVersionSchema;
export const subjectRuleSchema = _subjectRuleSchema as subjectRuleSchema;
export const supportedSubjectsSchema =
	_supportedSubjectsSchema as supportedSubjectsSchema;
export const transparencySchema = _transparencySchema as transparencySchema;

export interface Artifact extends v.InferInput<typeof artifactSchema> {}
export interface AssessmentSubject extends v.InferInput<
	typeof assessmentSubjectSchema
> {}
export interface Contact extends v.InferInput<typeof contactSchema> {}
export interface Coverage extends v.InferInput<typeof coverageSchema> {}
export interface CurrentAssessmentView extends v.InferInput<
	typeof currentAssessmentViewSchema
> {}
export interface LabelSummary extends v.InferInput<typeof labelSummarySchema> {}
export interface LabelerPolicy extends v.InferInput<
	typeof labelerPolicySchema
> {}
export interface ManualActionSubject extends v.InferInput<
	typeof manualActionSubjectSchema
> {}
export interface Model extends v.InferInput<typeof modelSchema> {}
export interface OverrideRule extends v.InferInput<typeof overrideRuleSchema> {}
export interface PolicyLabel extends v.InferInput<typeof policyLabelSchema> {}
export interface PolicyLocale extends v.InferInput<typeof policyLocaleSchema> {}
export interface PublicApi extends v.InferInput<typeof publicApiSchema> {}
export interface PublicAssessment extends v.InferInput<
	typeof publicAssessmentSchema
> {}
export interface PublicManualAction extends v.InferInput<
	typeof publicManualActionSchema
> {}
export interface PublisherSubject extends v.InferInput<
	typeof publisherSubjectSchema
> {}
export interface ReasonCode extends v.InferInput<typeof reasonCodeSchema> {}
export interface ScannerVersion extends v.InferInput<
	typeof scannerVersionSchema
> {}
export interface SubjectRule extends v.InferInput<typeof subjectRuleSchema> {}
export interface SupportedSubjects extends v.InferInput<
	typeof supportedSubjectsSchema
> {}
export interface Transparency extends v.InferInput<typeof transparencySchema> {}
