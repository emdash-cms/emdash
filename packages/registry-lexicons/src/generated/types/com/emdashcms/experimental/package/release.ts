import type {} from "@atcute/lexicons";
import type {} from "@atcute/lexicons/ambient";
import * as v from "@atcute/lexicons/validations";

const _artifactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.release#artifact"),
	),
	/**
	 * Multibase-encoded multihash of the artifact bytes. EmDash clients MUST support sha2-256 (multihash code 0x12) and SHOULD support sha2-512 (0x13) and blake3 (0x1e). Recommended base prefix: base32 ('b'). Clients reject artifacts whose checksum uses an unsupported hash function rather than skipping verification.
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 256),
	]),
	/**
	 * MIME type of the artifact, per RFC6838. FAIR HTTP equivalent: 'content-type'.
	 * @maxLength 256
	 */
	contentType: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
	),
	/**
	 * Pixel height, for image artifacts.
	 * @minimum 1
	 * @maximum 8192
	 */
	height: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [/*#__PURE__*/ v.integerRange(1, 8192)]),
	),
	/**
	 * Unique ID within the artifact type.
	 * @maxLength 128
	 */
	id: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 128)]),
	),
	/**
	 * BCP 47 language tag for localised artifacts (icon, screenshot).
	 */
	lang: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.languageCodeString()),
	/**
	 * Whether the URL points to a platform release asset rather than a directly-served file. When true, clients MUST send 'Accept: application/octet-stream' when downloading. FAIR HTTP equivalent: 'release-asset'.
	 */
	releaseAsset: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Whether the artifact requires authentication to access. FAIR HTTP equivalent: 'requires-auth'.
	 */
	requiresAuth: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Optional cryptographic signature of the artifact. Retained for FAIR compatibility, but EmDash clients do not require it as integrity is proven via the atproto MST signature over the record's checksum.
	 * @maxLength 1024
	 */
	signature: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 1024)]),
	),
	/**
	 * URL where the artifact can be downloaded.
	 * @maxLength 2048
	 */
	url: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
		/*#__PURE__*/ v.stringLength(0, 2048),
	]),
	/**
	 * Pixel width, for image artifacts (icon, screenshot, banner).
	 * @minimum 1
	 * @maximum 8192
	 */
	width: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [/*#__PURE__*/ v.integerRange(1, 8192)]),
	),
});
const _artifactsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.release#artifacts"),
	),
	get banner() {
		return /*#__PURE__*/ v.optional(artifactSchema);
	},
	get icon() {
		return /*#__PURE__*/ v.optional(artifactSchema);
	},
	/**
	 * The installable plugin bundle.
	 */
	get package() {
		return artifactSchema;
	},
	get screenshot() {
		return /*#__PURE__*/ v.optional(artifactSchema);
	},
});
const _mainSchema = /*#__PURE__*/ v.record(
	/*#__PURE__*/ v.string(),
	/*#__PURE__*/ v.object({
		$type: /*#__PURE__*/ v.literal("com.emdashcms.experimental.package.release"),
		/**
		 * Map of artifact type to artifact object. MUST have at least one entry. The 'package' entry (installable bundle) is required.
		 */
		get artifacts() {
			return artifactsSchema;
		},
		/**
		 * Authentication requirements (FAIR's commercial / private packages). Out of scope for EmDash use today, but the field is reserved.
		 */
		auth: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * Open-union container for extension data, keyed by NSID. Each value is an embedded record carrying its own $type discriminator. Releases of type emdash-plugin MUST include a com.emdashcms.experimental.package.releaseExtension entry here.
		 */
		extensions: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * Slug of the parent package profile in the same repository. MUST match the rkey of an existing package profile record. Combined with the publisher DID, the parent profile's AT URI is at://<publisher-did>/com.emdashcms.experimental.package.profile/<package>. Aggregators MUST reject release records whose package field does not resolve to a profile in the same repository.
		 * @minLength 1
		 * @maxLength 64
		 */
		package: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(1, 64),
		]),
		/**
		 * Capabilities the package provides. Map of capability type to string or list of strings. Open shape per FAIR's extension model.
		 */
		provides: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * AT URI or HTTPS URL of the source repository for this release. Equivalent to FAIR's 'https://fair.pm/rel/repo' HAL relation.
		 * @maxLength 1024
		 */
		repo: /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
				/*#__PURE__*/ v.stringLength(0, 1024),
			]),
		),
		/**
		 * Dependencies. Map of 'env:*' keys (extension-defined environment requirements) or package DIDs to version constraint strings. EmDash uses 'env:emdash' and 'env:astro'.
		 */
		requires: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * Software bill of materials reference.
		 */
		get sbom() {
			return /*#__PURE__*/ v.optional(sbomSchema);
		},
		/**
		 * Optional packages that may be installed alongside. Same shape as requires.
		 */
		suggests: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * Version, conforming to a subset of semver 2.0 (build metadata '+...' is disallowed because atproto record keys cannot represent it). MUST equal the post-':' portion of the rkey byte-for-byte. Composed only of characters allowed in atproto record keys: ASCII letters, digits, '.', and '-'. Note that while atproto rkeys also permit '_' and '~', semver disallows them in version strings, so they MUST NOT appear here.
		 * @minLength 1
		 * @maxLength 64
		 */
		version: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(1, 64),
		]),
	}),
);
const _sbomSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.release#sbom"),
	),
	/**
	 * Multibase-encoded multihash of the SBOM document, in the same format as artifact checksums.
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
	),
	/**
	 * SBOM format identifier.
	 * @maxLength 32
	 */
	format: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string<"cyclonedx" | "spdx" | (string & {})>(), [
			/*#__PURE__*/ v.stringLength(0, 32),
		]),
	),
	/**
	 * URL where the SBOM document can be fetched.
	 * @maxLength 2048
	 */
	url: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
			/*#__PURE__*/ v.stringLength(0, 2048),
		]),
	),
});

type artifact$schematype = typeof _artifactSchema;
type artifacts$schematype = typeof _artifactsSchema;
type main$schematype = typeof _mainSchema;
type sbom$schematype = typeof _sbomSchema;

export interface artifactSchema extends artifact$schematype {}
export interface artifactsSchema extends artifacts$schematype {}
export interface mainSchema extends main$schematype {}
export interface sbomSchema extends sbom$schematype {}

export const artifactSchema = _artifactSchema as artifactSchema;
export const artifactsSchema = _artifactsSchema as artifactsSchema;
export const mainSchema = _mainSchema as mainSchema;
export const sbomSchema = _sbomSchema as sbomSchema;

export interface Artifact extends v.InferInput<typeof artifactSchema> {}
export interface Artifacts extends v.InferInput<typeof artifactsSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Sbom extends v.InferInput<typeof sbomSchema> {}

declare module "@atcute/lexicons/ambient" {
	interface Records {
		"com.emdashcms.experimental.package.release": mainSchema;
	}
}
