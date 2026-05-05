import type {} from "@atcute/lexicons";
import type {} from "@atcute/lexicons/ambient";
import * as v from "@atcute/lexicons/validations";

const _contactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.publisher.profile#contact"),
	),
	/**
	 * @maxLength 256
	 */
	email: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
	),
	/**
	 * Channel role. 'general' for ordinary contact, 'security' for vulnerability reporting.
	 * @maxLength 32
	 */
	kind: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string<"general" | "security" | (string & {})>(), [
			/*#__PURE__*/ v.stringLength(0, 32),
		]),
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
	/*#__PURE__*/ v.literal("self"),
	/*#__PURE__*/ v.object({
		$type: /*#__PURE__*/ v.literal("com.emdashcms.experimental.publisher.profile"),
		/**
		 * Identity-level contact channels for the publisher (general / security). Per-package security contacts on package profile records remain authoritative for their respective packages; this list is for the publisher entity itself.
		 * @maxLength 8
		 */
		get contact() {
			return /*#__PURE__*/ v.optional(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(contactSchema), [
					/*#__PURE__*/ v.arrayLength(0, 8),
				]),
			);
		},
		/**
		 * Short description / bio of the publisher. SHOULD NOT exceed 280 characters per UI convention. Plain text; no Markdown.
		 * @maxLength 2048
		 * @maxGraphemes 280
		 */
		description: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
				/*#__PURE__*/ v.stringLength(0, 2048),
				/*#__PURE__*/ v.stringGraphemes(0, 280),
			]),
		),
		/**
		 * Human-readable name for the publisher (e.g. 'Acme Plugin Co.'). Displayed alongside packages and verification badges. Verification records bind against this value: a change to displayName invalidates any unexpired verification claims targeting this DID until the issuer re-attests.
		 * @maxLength 1024
		 * @maxGraphemes 100
		 */
		displayName: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
			/*#__PURE__*/ v.stringGraphemes(0, 100),
		]),
		/**
		 * When this profile was last updated.
		 */
		updatedAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
		/**
		 * Publisher's primary homepage. Distinct from per-package repo or homepage URLs.
		 * @maxLength 2048
		 */
		url: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
				/*#__PURE__*/ v.stringLength(0, 2048),
			]),
		),
	}),
);

type contact$schematype = typeof _contactSchema;
type main$schematype = typeof _mainSchema;

export interface contactSchema extends contact$schematype {}
export interface mainSchema extends main$schematype {}

export const contactSchema = _contactSchema as contactSchema;
export const mainSchema = _mainSchema as mainSchema;

export interface Contact extends v.InferInput<typeof contactSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
	interface Records {
		"com.emdashcms.experimental.publisher.profile": mainSchema;
	}
}
