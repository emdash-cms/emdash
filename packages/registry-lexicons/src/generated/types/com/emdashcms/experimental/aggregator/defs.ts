import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import * as ComAtprotoLabelDefs from "@atcute/atproto/types/label/defs";

const _packageViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.aggregator.defs#packageView",
		),
	),
	/**
	 * CID of the profile record content the aggregator indexed. Lets clients confirm they're working with the same bytes the aggregator did.
	 */
	cid: /*#__PURE__*/ v.cidString(),
	/**
	 * Publisher DID. Denormalised convenience; equivalent to the DID portion of `uri`.
	 */
	did: /*#__PURE__*/ v.didString(),
	/**
	 * Publisher's current handle, if known. Best-effort: handles are mutable and may be stale at the moment of read.
	 */
	handle: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.handleString()),
	/**
	 * When the aggregator first indexed this package.
	 */
	indexedAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * Hydrated labels applying to this package, per the labelers the request asked for via the atproto-accept-labelers header.
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(
				/*#__PURE__*/ v.array(ComAtprotoLabelDefs.labelSchema),
				[/*#__PURE__*/ v.arrayLength(0, 64)],
			),
		);
	},
	/**
	 * Convenience: the highest semver version among non-tombstoned, non-yanked releases the aggregator has indexed for this package. Clients SHOULD verify this against their own selection from listReleases when the difference matters.
	 * @maxLength 64
	 */
	latestVersion: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 64),
		]),
	),
	/**
	 * The signed profile record verbatim, passed through from the publisher's repo (carrying its $type, all required fields, etc.).
	 */
	profile: /*#__PURE__*/ v.unknown(),
	/**
	 * Package slug (the rkey of the profile record). Denormalised convenience.
	 * @minLength 1
	 * @maxLength 64
	 */
	slug: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * AT URI of the profile record the aggregator indexed. Pins exactly which record version this view describes.
	 */
	uri: /*#__PURE__*/ v.resourceUriString(),
});
const _publisherVerificationViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.aggregator.defs#publisherVerificationView",
		),
	),
	/**
	 * Subject publisher DID the verification state is for.
	 */
	did: /*#__PURE__*/ v.didString(),
	/**
	 * Hydrated labels applying to this publisher DID, per the labelers the request asked for via the atproto-accept-labelers header.
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(
				/*#__PURE__*/ v.array(ComAtprotoLabelDefs.labelSchema),
				[/*#__PURE__*/ v.arrayLength(0, 64)],
			),
		);
	},
	/**
	 * Non-tombstoned verification claims naming this DID as subject, newest issuance first.
	 * @maxLength 100
	 */
	get verifications() {
		return /*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(verificationClaimViewSchema),
			[/*#__PURE__*/ v.arrayLength(0, 100)],
		);
	},
});
const _publisherViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.aggregator.defs#publisherView",
		),
	),
	/**
	 * CID of the profile record content the aggregator indexed. Lets clients confirm they're working with the same bytes the aggregator did.
	 */
	cid: /*#__PURE__*/ v.cidString(),
	/**
	 * Publisher DID. Denormalised convenience; equivalent to the DID portion of `uri`.
	 */
	did: /*#__PURE__*/ v.didString(),
	/**
	 * Publisher's current handle, if known. Best-effort: handles are mutable and may be stale at the moment of read.
	 */
	handle: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.handleString()),
	/**
	 * When the aggregator first indexed this publisher.
	 */
	indexedAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * Hydrated labels applying to this publisher DID, per the labelers the request asked for via the atproto-accept-labelers header.
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(
				/*#__PURE__*/ v.array(ComAtprotoLabelDefs.labelSchema),
				[/*#__PURE__*/ v.arrayLength(0, 64)],
			),
		);
	},
	/**
	 * The signed publisher.profile record verbatim, passed through from the publisher's repo (carrying its $type, displayName, contact channels, etc.).
	 */
	profile: /*#__PURE__*/ v.unknown(),
	/**
	 * AT URI of the publisher.profile record the aggregator indexed (rkey is always 'self'). Pins exactly which record version this view describes.
	 */
	uri: /*#__PURE__*/ v.resourceUriString(),
});
const _releaseViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.aggregator.defs#releaseView",
		),
	),
	/**
	 * CID of the release record content the aggregator indexed.
	 */
	cid: /*#__PURE__*/ v.cidString(),
	/**
	 * Publisher DID. Denormalised convenience; equivalent to the DID portion of `uri`.
	 */
	did: /*#__PURE__*/ v.didString(),
	/**
	 * When the aggregator first indexed this release.
	 */
	indexedAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * Hydrated labels applying to this release, per the labelers the request asked for.
	 * @maxLength 64
	 */
	get labels() {
		return /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(
				/*#__PURE__*/ v.array(ComAtprotoLabelDefs.labelSchema),
				[/*#__PURE__*/ v.arrayLength(0, 64)],
			),
		);
	},
	/**
	 * URLs the aggregator currently serves the primary `package` artifact from. Empty if the aggregator did not mirror this release (e.g. license is non-redistributable). The URL shape is opaque per the aggregator; clients treat them as-is and verify checksums on download.
	 * @maxLength 16
	 */
	mirrors: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
					/*#__PURE__*/ v.stringLength(0, 2048),
				]),
			),
			[/*#__PURE__*/ v.arrayLength(0, 16)],
		),
	),
	/**
	 * Parent package slug. Denormalised convenience.
	 * @minLength 1
	 * @maxLength 64
	 */
	package: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
	/**
	 * The signed release record verbatim from the publisher's repo (carrying its $type and all fields).
	 */
	release: /*#__PURE__*/ v.unknown(),
	/**
	 * AT URI of the release record the aggregator indexed. Pins exactly which record version this view describes.
	 */
	uri: /*#__PURE__*/ v.resourceUriString(),
	/**
	 * Release version, matching the post-':' portion of the rkey.
	 * @minLength 1
	 * @maxLength 64
	 */
	version: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(1, 64),
	]),
});
const _verificationClaimViewSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.aggregator.defs#verificationClaimView",
		),
	),
	/**
	 * When the verification was issued.
	 */
	createdAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * Subject publisher-profile displayName bound at issuance.
	 * @maxLength 1024
	 * @maxGraphemes 100
	 */
	displayName: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 1024),
		/*#__PURE__*/ v.stringGraphemes(0, 100),
	]),
	/**
	 * Optional expiry. Absent means no automatic expiry.
	 */
	expiresAt: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.datetimeString()),
	/**
	 * Subject handle bound at issuance.
	 */
	handle: /*#__PURE__*/ v.handleString(),
	/**
	 * When the aggregator first indexed this verification.
	 */
	indexedAt: /*#__PURE__*/ v.datetimeString(),
	/**
	 * DID of the repo that issued the verification.
	 */
	issuer: /*#__PURE__*/ v.didString(),
});

type packageView$schematype = typeof _packageViewSchema;
type publisherVerificationView$schematype =
	typeof _publisherVerificationViewSchema;
type publisherView$schematype = typeof _publisherViewSchema;
type releaseView$schematype = typeof _releaseViewSchema;
type verificationClaimView$schematype = typeof _verificationClaimViewSchema;

export interface packageViewSchema extends packageView$schematype {}
export interface publisherVerificationViewSchema extends publisherVerificationView$schematype {}
export interface publisherViewSchema extends publisherView$schematype {}
export interface releaseViewSchema extends releaseView$schematype {}
export interface verificationClaimViewSchema extends verificationClaimView$schematype {}

export const packageViewSchema = _packageViewSchema as packageViewSchema;
export const publisherVerificationViewSchema =
	_publisherVerificationViewSchema as publisherVerificationViewSchema;
export const publisherViewSchema = _publisherViewSchema as publisherViewSchema;
export const releaseViewSchema = _releaseViewSchema as releaseViewSchema;
export const verificationClaimViewSchema =
	_verificationClaimViewSchema as verificationClaimViewSchema;

export interface PackageView extends v.InferInput<typeof packageViewSchema> {}
export interface PublisherVerificationView extends v.InferInput<
	typeof publisherVerificationViewSchema
> {}
export interface PublisherView extends v.InferInput<
	typeof publisherViewSchema
> {}
export interface ReleaseView extends v.InferInput<typeof releaseViewSchema> {}
export interface VerificationClaimView extends v.InferInput<
	typeof verificationClaimViewSchema
> {}
