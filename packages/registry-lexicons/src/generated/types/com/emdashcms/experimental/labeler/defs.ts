import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";

const _assessmentSubjectSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#assessmentSubject",
		),
	),
	/**
	 * CID of the exact assessed record revision.
	 */
	cid: /*#__PURE__*/ v.cidString(),
	/**
	 * Whether the record supplies package-profile metadata or release metadata and media.
	 */
	kind: /*#__PURE__*/ v.string<"profile" | "release" | (string & {})>(),
	/**
	 * AT URI of the assessed record.
	 */
	uri: /*#__PURE__*/ v.resourceUriString(),
});
const _coverageSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.labeler.defs#coverage"),
	),
	links: /*#__PURE__*/ v.string<
		"complete" | "not-present" | "unavailable" | (string & {})
	>(),
	media: /*#__PURE__*/ v.string<
		"complete" | "not-present" | "partial" | "unavailable" | (string & {})
	>(),
	text: /*#__PURE__*/ v.string<
		"complete" | "not-present" | "unavailable" | (string & {})
	>(),
});
const _currentAssessmentViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#currentAssessmentView",
		),
	),
	/**
	 * Effective signed label state for this exact record revision.
	 * @maxLength 16
	 */
	get activeLabels() {
		return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(signedLabelSchema), [
			/*#__PURE__*/ v.arrayLength(0, 16),
		]);
	},
	get assessment() {
		return publicAssessmentSchema;
	},
	src: /*#__PURE__*/ v.didString(),
	get subject() {
		return assessmentSubjectSchema;
	},
});
const _labelDefinitionSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#labelDefinition",
		),
	),
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
	officialEffect: /*#__PURE__*/ v.string<
		"eligible" | "ineligible" | "informational" | "redact" | (string & {})
	>(),
	/**
	 * @minLength 1
	 * @maxLength 2
	 */
	subjectKinds: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(
			/*#__PURE__*/ v.string<"profile" | "release" | (string & {})>(),
		),
		[/*#__PURE__*/ v.arrayLength(1, 2)],
	),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	value: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.string<
			| "!takedown"
			| "listing-blocked"
			| "listing-error"
			| "listing-overridden"
			| "listing-passed"
			| "listing-pending"
			| "listing-review"
			| (string & {})
		>(),
		[/*#__PURE__*/ v.stringLength(1, 128)],
	),
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
	effectiveAt: /*#__PURE__*/ v.datetimeString(),
	labelerDid: /*#__PURE__*/ v.didString(),
	/**
	 * @minLength 1
	 * @maxLength 16
	 */
	get labels() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(labelDefinitionSchema),
			[/*#__PURE__*/ v.arrayLength(1, 16)],
		);
	},
	/**
	 * @maxLength 4
	 */
	get models() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(modelDescriptorSchema),
			[/*#__PURE__*/ v.arrayLength(0, 4)],
		);
	},
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	parserVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	policyVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	get publicApi() {
		return publicApiSchema;
	},
	/**
	 * @maxLength 64
	 */
	get reasonCodes() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(reasonCodeDefinitionSchema),
			[/*#__PURE__*/ v.arrayLength(0, 64)],
		);
	},
	/**
	 * @minimum 1
	 * @maximum 1
	 */
	schemaVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
		/*#__PURE__*/ v.integerRange(1, 1),
	]),
	/**
	 * @minLength 1
	 * @maxLength 2
	 */
	get supportedSubjects() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(subjectPolicySchema),
			[/*#__PURE__*/ v.arrayLength(1, 2)],
		);
	},
});
const _manualDecisionSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#manualDecision",
		),
	),
	decidedAt: /*#__PURE__*/ v.datetimeString(),
	outcome: /*#__PURE__*/ v.string<"approved" | "blocked" | (string & {})>(),
	/**
	 * @minLength 1
	 * @maxLength 64
	 */
	reasonCode: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
});
const _modelDescriptorSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#modelDescriptor",
		),
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
	modelVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * Stable digest of the prompt and strict output contract.
	 * @minLength 1
	 * @maxLength 128
	 */
	promptHash: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @maxLength 64
	 */
	provider: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.string<"workers-ai" | (string & {})>(),
		[/*#__PURE__*/ v.stringLength(0, 64)],
	),
	purpose: /*#__PURE__*/ v.string<"image" | "text" | (string & {})>(),
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
});
const _publicAssessmentSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publicAssessment",
		),
	),
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
	 * @maxLength 32
	 */
	get findings() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(publicFindingSchema),
			[/*#__PURE__*/ v.arrayLength(0, 32)],
		);
	},
	/**
	 * @minLength 1
	 * @maxLength 100
	 */
	id: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 100),
	]),
	/**
	 * Signed outcome labels emitted by this assessment run. Effective moderation state comes from com.atproto.label queries and subscriptions.
	 * @maxLength 16
	 */
	get labels() {
		return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(signedLabelSchema), [
			/*#__PURE__*/ v.arrayLength(0, 16),
		]);
	},
	get manualDecision() {
		return /*#__PURE__*/ v.optional(manualDecisionSchema);
	},
	/**
	 * @maxLength 4
	 */
	get models() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(modelDescriptorSchema),
			[/*#__PURE__*/ v.arrayLength(0, 4)],
		);
	},
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	parserVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * @minLength 1
	 * @maxLength 128
	 */
	policyVersion: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * Stable public reason codes defined by policyVersion.
	 * @maxLength 32
	 */
	reasonCodes: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.array(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(1, 64),
			]),
		),
		[/*#__PURE__*/ v.arrayLength(0, 32)],
	),
	/**
	 * DID that issues this assessment's signed labels.
	 */
	src: /*#__PURE__*/ v.didString(),
	state: /*#__PURE__*/ v.string<
		| "blocked"
		| "error"
		| "passed"
		| "pending"
		| "review"
		| "superseded"
		| (string & {})
	>(),
	get subject() {
		return assessmentSubjectSchema;
	},
	/**
	 * Optional labeler-authored public summary without raw assessed content.
	 * @maxLength 1024
	 */
	summary: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
		]),
	),
	/**
	 * @minLength 1
	 * @maxLength 100
	 */
	supersededByAssessmentId: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(1, 100),
		]),
	),
});
const _publicFindingSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#publicFinding",
		),
	),
	category: /*#__PURE__*/ v.string<
		| "explicit-sexual-content"
		| "graphic-violence"
		| "hateful-or-dehumanizing-content"
		| "malicious-or-deceptive-link"
		| "material-impersonation"
		| "misleading-media-or-claims"
		| "phishing-or-credential-solicitation"
		| "scam-or-spam"
		| (string & {})
	>(),
	/**
	 * Stable code defined by the assessment's policy version.
	 * @minLength 1
	 * @maxLength 64
	 */
	reasonCode: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * Labeler-authored public explanation without raw assessed content.
	 * @minLength 1
	 * @maxLength 512
	 */
	summary: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 512),
	]),
});
const _reasonCodeDefinitionSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#reasonCodeDefinition",
		),
	),
	/**
	 * @minLength 1
	 * @maxLength 64
	 */
	code: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * @minLength 1
	 * @maxLength 512
	 */
	description: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 512),
	]),
});
const _signedLabelSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#signedLabel",
		),
	),
	/**
	 * Optional CID of the exact resource revision to which the label applies.
	 */
	cid: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.cidString()),
	/**
	 * Time at which the label was created.
	 */
	cts: /*#__PURE__*/ v.datetimeString(),
	/**
	 * Optional time after which the label no longer applies.
	 */
	exp: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
	/**
	 * Whether this event negates prior label state.
	 */
	neg: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Signature over the canonical DAG-CBOR label payload.
	 */
	sig: /*#__PURE__*/ v.bytes(),
	/**
	 * DID of the label issuer.
	 */
	src: /*#__PURE__*/ v.didString(),
	/**
	 * Resource to which the label applies.
	 */
	uri: /*#__PURE__*/ v.genericUriString(),
	/**
	 * Label value.
	 * @minLength 1
	 * @maxLength 128
	 */
	val: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 128),
	]),
	/**
	 * AT Protocol label version.
	 */
	ver: /*#__PURE__*/ v.integer(),
});
const _subjectPolicySchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.labeler.defs#subjectPolicy",
		),
	),
	collection: /*#__PURE__*/ v.nsidString(),
	kind: /*#__PURE__*/ v.string<"profile" | "release" | (string & {})>(),
});

type assessmentSubject$schematype = typeof _assessmentSubjectSchema;
type coverage$schematype = typeof _coverageSchema;
type currentAssessmentView$schematype = typeof _currentAssessmentViewSchema;
type labelDefinition$schematype = typeof _labelDefinitionSchema;
type labelerPolicy$schematype = typeof _labelerPolicySchema;
type manualDecision$schematype = typeof _manualDecisionSchema;
type modelDescriptor$schematype = typeof _modelDescriptorSchema;
type publicApi$schematype = typeof _publicApiSchema;
type publicAssessment$schematype = typeof _publicAssessmentSchema;
type publicFinding$schematype = typeof _publicFindingSchema;
type reasonCodeDefinition$schematype = typeof _reasonCodeDefinitionSchema;
type signedLabel$schematype = typeof _signedLabelSchema;
type subjectPolicy$schematype = typeof _subjectPolicySchema;

export interface assessmentSubjectSchema extends assessmentSubject$schematype {}
export interface coverageSchema extends coverage$schematype {}
export interface currentAssessmentViewSchema extends currentAssessmentView$schematype {}
export interface labelDefinitionSchema extends labelDefinition$schematype {}
export interface labelerPolicySchema extends labelerPolicy$schematype {}
export interface manualDecisionSchema extends manualDecision$schematype {}
export interface modelDescriptorSchema extends modelDescriptor$schematype {}
export interface publicApiSchema extends publicApi$schematype {}
export interface publicAssessmentSchema extends publicAssessment$schematype {}
export interface publicFindingSchema extends publicFinding$schematype {}
export interface reasonCodeDefinitionSchema extends reasonCodeDefinition$schematype {}
export interface signedLabelSchema extends signedLabel$schematype {}
export interface subjectPolicySchema extends subjectPolicy$schematype {}

export const assessmentSubjectSchema =
	_assessmentSubjectSchema as assessmentSubjectSchema;
export const coverageSchema = _coverageSchema as coverageSchema;
export const currentAssessmentViewSchema =
	_currentAssessmentViewSchema as currentAssessmentViewSchema;
export const labelDefinitionSchema =
	_labelDefinitionSchema as labelDefinitionSchema;
export const labelerPolicySchema = _labelerPolicySchema as labelerPolicySchema;
export const manualDecisionSchema =
	_manualDecisionSchema as manualDecisionSchema;
export const modelDescriptorSchema =
	_modelDescriptorSchema as modelDescriptorSchema;
export const publicApiSchema = _publicApiSchema as publicApiSchema;
export const publicAssessmentSchema =
	_publicAssessmentSchema as publicAssessmentSchema;
export const publicFindingSchema = _publicFindingSchema as publicFindingSchema;
export const reasonCodeDefinitionSchema =
	_reasonCodeDefinitionSchema as reasonCodeDefinitionSchema;
export const signedLabelSchema = _signedLabelSchema as signedLabelSchema;
export const subjectPolicySchema = _subjectPolicySchema as subjectPolicySchema;

export interface AssessmentSubject extends v.InferInput<
	typeof assessmentSubjectSchema
> {}
export interface Coverage extends v.InferInput<typeof coverageSchema> {}
export interface CurrentAssessmentView extends v.InferInput<
	typeof currentAssessmentViewSchema
> {}
export interface LabelDefinition extends v.InferInput<
	typeof labelDefinitionSchema
> {}
export interface LabelerPolicy extends v.InferInput<
	typeof labelerPolicySchema
> {}
export interface ManualDecision extends v.InferInput<
	typeof manualDecisionSchema
> {}
export interface ModelDescriptor extends v.InferInput<
	typeof modelDescriptorSchema
> {}
export interface PublicApi extends v.InferInput<typeof publicApiSchema> {}
export interface PublicAssessment extends v.InferInput<
	typeof publicAssessmentSchema
> {}
export interface PublicFinding extends v.InferInput<
	typeof publicFindingSchema
> {}
export interface ReasonCodeDefinition extends v.InferInput<
	typeof reasonCodeDefinitionSchema
> {}
export interface SignedLabel extends v.InferInput<typeof signedLabelSchema> {}
export interface SubjectPolicy extends v.InferInput<
	typeof subjectPolicySchema
> {}
