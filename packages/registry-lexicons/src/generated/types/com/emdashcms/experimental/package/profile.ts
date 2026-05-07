import type {} from "@atcute/lexicons";
import type {} from "@atcute/lexicons/ambient";
import * as v from "@atcute/lexicons/validations";

const _authorSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.profile#author"),
	),
	/**
	 * @maxLength 256
	 */
	email: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
	),
	/**
	 * @maxLength 256
	 * @maxGraphemes 64
	 */
	name: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 256),
		/*#__PURE__*/ v.stringGraphemes(0, 64),
	]),
	/**
	 * @maxLength 1024
	 */
	url: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
		]),
	),
});
const _contactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.profile#contact"),
	),
	/**
	 * @maxLength 256
	 */
	email: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
	),
	/**
	 * @maxLength 1024
	 */
	url: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
		]),
	),
});
const _mainSchema = /*#__PURE__*/ v.record(
	/*#__PURE__*/ v.string(),
	/*#__PURE__*/ v.object({
		$type: /*#__PURE__*/ v.literal("com.emdashcms.experimental.package.profile"),
		/**
		 * At least one author. Vendors SHOULD specify at least one of url or email per author.
		 * @minLength 1
		 * @maxLength 32
		 */
		get authors() {
			return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(authorSchema), [
				/*#__PURE__*/ v.arrayLength(1, 32),
			]);
		},
		/**
		 * Short description of the package. SHOULD NOT exceed 140 characters per FAIR convention.
		 * @maxLength 1024
		 * @maxGraphemes 140
		 */
		description: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(0, 1024),
				/*#__PURE__*/ v.stringGraphemes(0, 140),
			]),
		),
		/**
		 * Canonical AT URI of this profile record. Derived from the record's location at publish time; not authored by the publisher. Aggregators MUST reject records whose id does not match the AT URI they were fetched from. Mirrors FAIR's id-must-match-the-resolved-identifier rule.
		 */
		id: /*#__PURE__*/ v.resourceUriString(),
		/**
		 * Search keywords. SHOULD NOT exceed 5 items per FAIR convention.
		 * @maxLength 5
		 */
		keywords: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(
				/*#__PURE__*/ v.array(
					/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
						/*#__PURE__*/ v.stringLength(0, 128),
						/*#__PURE__*/ v.stringGraphemes(0, 64),
					]),
				),
				[/*#__PURE__*/ v.arrayLength(0, 5)],
			),
		),
		/**
		 * ISO 8601 datetime for the package's last update.
		 */
		lastUpdated: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
		/**
		 * SPDX license expression, or the literal 'proprietary'. Clients SHOULD refuse to install packages without a valid license.
		 * @maxLength 256
		 */
		license: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 256),
		]),
		/**
		 * Human-readable name for the package, displayed in directory listings.
		 * @maxLength 1024
		 * @maxGraphemes 100
		 */
		name: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(0, 1024),
				/*#__PURE__*/ v.stringGraphemes(0, 100),
			]),
		),
		/**
		 * Map of human-readable text sections (description, installation, faq, changelog, security). CommonMark Markdown. Each value capped at 20000 bytes / 2000 graphemes.
		 */
		get sections() {
			return /*#__PURE__*/ v.optional(sectionsSchema);
		},
		/**
		 * At least one security contact. Vendors SHOULD specify at least one of url or email per contact. Clients SHOULD refuse to install packages without at least one valid security contact.
		 * @minLength 1
		 * @maxLength 8
		 */
		get security() {
			return /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(contactSchema), [
				/*#__PURE__*/ v.arrayLength(1, 8),
			]);
		},
		/**
		 * URL-safe slug. ASCII letter followed by ASCII letters, digits, '-', or '_'. If present, MUST equal the record key. If absent, clients use the rkey as the display slug. Aggregators MUST reject records where slug is present and disagrees with the rkey.
		 * @minLength 1
		 * @maxLength 64
		 */
		slug: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(1, 64)]),
		),
		/**
		 * Package type from FAIR's type registry. EmDash plugins use 'emdash-plugin'. Custom types use the 'x-' prefix.
		 * @maxLength 64
		 */
		type: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string<"emdash-plugin" | (string & {})>(), [
			/*#__PURE__*/ v.stringLength(0, 64),
		]),
	}),
);
const _sectionsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.profile#sections"),
	),
	/**
	 * @maxLength 20000
	 * @maxGraphemes 2000
	 */
	changelog: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 20000),
			/*#__PURE__*/ v.stringGraphemes(0, 2000),
		]),
	),
	/**
	 * @maxLength 20000
	 * @maxGraphemes 2000
	 */
	description: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 20000),
			/*#__PURE__*/ v.stringGraphemes(0, 2000),
		]),
	),
	/**
	 * @maxLength 20000
	 * @maxGraphemes 2000
	 */
	faq: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 20000),
			/*#__PURE__*/ v.stringGraphemes(0, 2000),
		]),
	),
	/**
	 * @maxLength 20000
	 * @maxGraphemes 2000
	 */
	installation: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 20000),
			/*#__PURE__*/ v.stringGraphemes(0, 2000),
		]),
	),
	/**
	 * @maxLength 20000
	 * @maxGraphemes 2000
	 */
	security: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 20000),
			/*#__PURE__*/ v.stringGraphemes(0, 2000),
		]),
	),
});

type author$schematype = typeof _authorSchema;
type contact$schematype = typeof _contactSchema;
type main$schematype = typeof _mainSchema;
type sections$schematype = typeof _sectionsSchema;

export interface authorSchema extends author$schematype {}
export interface contactSchema extends contact$schematype {}
export interface mainSchema extends main$schematype {}
export interface sectionsSchema extends sections$schematype {}

export const authorSchema = _authorSchema as authorSchema;
export const contactSchema = _contactSchema as contactSchema;
export const mainSchema = _mainSchema as mainSchema;
export const sectionsSchema = _sectionsSchema as sectionsSchema;

export interface Author extends v.InferInput<typeof authorSchema> {}
export interface Contact extends v.InferInput<typeof contactSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Sections extends v.InferInput<typeof sectionsSchema> {}

declare module "@atcute/lexicons/ambient" {
	interface Records {
		"com.emdashcms.experimental.package.profile": mainSchema;
	}
}
