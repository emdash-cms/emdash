import type {} from "@atcute/lexicons";
import type {} from "@atcute/lexicons/ambient";
import * as v from "@atcute/lexicons/validations";

const _mainSchema = /*#__PURE__*/ v.record(
	/*#__PURE__*/ v.tidString(),
	/*#__PURE__*/ v.object({
		$type: /*#__PURE__*/ v.literal("com.emdashcms.experimental.publisher.verification"),
		/**
		 * When the verification was issued.
		 */
		createdAt: /*#__PURE__*/ v.datetimeString(),
		/**
		 * Subject's `displayName` from their `com.emdashcms.experimental.publisher.profile` record (rkey `self`) at the moment of issuance. The verification is only valid if the subject's current publisher profile displayName matches this value byte-for-byte. A subject without a publisher profile cannot be verified: the issuer MUST require the subject to publish a publisher.profile before issuing the claim, and clients MUST reject verifications whose subject has no publisher profile resolvable at issuance check time.
		 * @maxLength 1024
		 * @maxGraphemes 100
		 */
		displayName: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
			/*#__PURE__*/ v.stringGraphemes(0, 100),
		]),
		/**
		 * Optional expiration timestamp. If absent, the verification has no automatic expiry. Clients SHOULD treat the verification as not in force after this time, regardless of whether the issuer has revoked it.
		 */
		expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
		/**
		 * Handle of the subject at the moment of issuance. The verification is only valid if the subject's current handle (resolved from their DID document) matches this value byte-for-byte. Any handle change invalidates the verification until the issuer re-attests.
		 */
		handle: /*#__PURE__*/ v.handleString(),
		/**
		 * DID of the subject the verification applies to.
		 */
		subject: /*#__PURE__*/ v.didString(),
	}),
);

type main$schematype = typeof _mainSchema;

export interface mainSchema extends main$schematype {}

export const mainSchema = _mainSchema as mainSchema;

export interface Main extends v.InferInput<typeof mainSchema> {}

declare module "@atcute/lexicons/ambient" {
	interface Records {
		"com.emdashcms.experimental.publisher.verification": mainSchema;
	}
}
