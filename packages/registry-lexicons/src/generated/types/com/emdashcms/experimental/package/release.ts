import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";
import type {} from "@atcute/lexicons/ambient";

const _artifactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.release#artifact",
		),
	),
	/**
	 * Artifact bytes stored as a blob in the publisher's PDS.
	 * @accept application/gzip
	 * @maxSize 262144
	 */
	blob: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.blob(), [
			/*#__PURE__*/ v.blobSize(262144),
			/*#__PURE__*/ v.blobAccept(["application/gzip"]),
		]),
	),
	/**
	 * Lowercase base32 multibase-encoded sha2-256 multihash of the artifact bytes (multihash code 0x12). EmDash clients reject unsupported hash functions rather than skipping verification.
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 256),
	]),
	/**
	 * MIME type of the artifact, per RFC6838.
	 * @maxLength 256
	 */
	contentType: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 256),
		]),
	),
	/**
	 * Pixel height, for image artifacts.
	 * @minimum 1
	 * @maximum 8192
	 */
	height: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
			/*#__PURE__*/ v.integerRange(1, 8192),
		]),
	),
	/**
	 * Unique ID within the artifact type.
	 * @maxLength 128
	 */
	id: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 128),
		]),
	),
	/**
	 * BCP 47 language tag for localised artifacts (icon, screenshot).
	 */
	lang: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.languageCodeString()),
	/**
	 * Whether the URL points to a platform release asset rather than a directly-served file. When true, clients MUST send 'Accept: application/octet-stream' when downloading.
	 */
	releaseAsset: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Whether the artifact requires authentication to access.
	 */
	requiresAuth: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Optional cryptographic signature of the artifact. EmDash clients do not require it because integrity is proven through the atproto MST signature over the record's checksum.
	 * @maxLength 1024
	 */
	signature: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
		]),
	),
	/**
	 * URL where the artifact can be downloaded.
	 * @maxLength 2048
	 */
	url: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
			/*#__PURE__*/ v.stringLength(0, 2048),
		]),
	),
	/**
	 * Pixel width, for image artifacts (icon, screenshot, banner).
	 * @minimum 1
	 * @maximum 8192
	 */
	width: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
			/*#__PURE__*/ v.integerRange(1, 8192),
		]),
	),
});
const _artifactsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.release#artifacts",
		),
	),
	get banner() {
		return /*#__PURE__*/ v.optional(imageArtifactSchema);
	},
	get icon() {
		return /*#__PURE__*/ v.optional(imageArtifactSchema);
	},
	/**
	 * The installable plugin bundle.
	 */
	get package() {
		return artifactSchema;
	},
	/**
	 * Ordered screenshot gallery for the plugin's detail page.
	 * @maxLength 8
	 */
	get screenshots() {
		return /*#__PURE__*/ v.optional(
			/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.array(imageArtifactSchema), [
				/*#__PURE__*/ v.arrayLength(0, 8),
			]),
		);
	},
});
const _imageArtifactSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.release#imageArtifact",
		),
	),
	/**
	 * Image bytes stored as a blob in the publisher's PDS.
	 * @accept image/png, image/jpeg, image/webp
	 * @maxSize 1048576
	 */
	blob: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.blob(), [
			/*#__PURE__*/ v.blobSize(1048576),
			/*#__PURE__*/ v.blobAccept(["image/png", "image/jpeg", "image/webp"]),
		]),
	),
	/**
	 * Lowercase base32 multibase-encoded sha2-256 multihash of the artifact bytes (multihash code 0x12). EmDash clients reject unsupported hash functions rather than skipping verification.
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 256),
	]),
	/**
	 * MIME type of the artifact, per RFC6838.
	 * @maxLength 256
	 */
	contentType: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 256),
		]),
	),
	/**
	 * Pixel height.
	 * @minimum 1
	 * @maximum 8192
	 */
	height: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
			/*#__PURE__*/ v.integerRange(1, 8192),
		]),
	),
	/**
	 * Unique ID within the artifact type.
	 * @maxLength 128
	 */
	id: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 128),
		]),
	),
	/**
	 * BCP 47 language tag for a localised artifact.
	 */
	lang: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.languageCodeString()),
	/**
	 * Whether the URL points to a platform release asset rather than a directly-served file. When true, clients MUST send 'Accept: application/octet-stream' when downloading.
	 */
	releaseAsset: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Whether the artifact requires authentication to access.
	 */
	requiresAuth: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.boolean()),
	/**
	 * Optional cryptographic signature of the artifact. EmDash clients do not require it because integrity is proven through the atproto MST signature over the record's checksum.
	 * @maxLength 1024
	 */
	signature: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 1024),
		]),
	),
	/**
	 * URL where the artifact can be downloaded.
	 * @maxLength 2048
	 */
	url: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
			/*#__PURE__*/ v.stringLength(0, 2048),
		]),
	),
	/**
	 * Pixel width.
	 * @minimum 1
	 * @maximum 8192
	 */
	width: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.integer(), [
			/*#__PURE__*/ v.integerRange(1, 8192),
		]),
	),
});
const _mainSchema = /*#__PURE__*/ v.record(
	/*#__PURE__*/ v.string(),
	/*#__PURE__*/ v.object({
		$type: /*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.release",
		),
		/**
		 * Map of artifact type to artifact object. MUST have at least one entry. The 'package' entry (installable bundle) is required.
		 */
		get artifacts() {
			return artifactsSchema;
		},
		/**
		 * Authentication requirements for gated artifacts. No authentication variants are currently defined.
		 */
		get auth() {
			return /*#__PURE__*/ v.optional(/*#__PURE__*/ v.variant([]));
		},
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
		 * Capabilities the package provides. Map of capability type to string or list of strings.
		 */
		provides: /*#__PURE__*/ v.optional(/*#__PURE__*/ v.unknown()),
		/**
		 * AT URI or HTTPS URL of the source repository for this release.
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
		/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
			/*#__PURE__*/ v.stringLength(0, 256),
		]),
	),
	/**
	 * SBOM format identifier.
	 * @maxLength 32
	 */
	format: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.string<"cyclonedx" | "spdx" | (string & {})>(),
			[/*#__PURE__*/ v.stringLength(0, 32)],
		),
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
type imageArtifact$schematype = typeof _imageArtifactSchema;
type main$schematype = typeof _mainSchema;
type sbom$schematype = typeof _sbomSchema;

export interface artifactSchema extends artifact$schematype {}
export interface artifactsSchema extends artifacts$schematype {}
export interface imageArtifactSchema extends imageArtifact$schematype {}
export interface mainSchema extends main$schematype {}
export interface sbomSchema extends sbom$schematype {}

export const artifactSchema = _artifactSchema as artifactSchema;
export const artifactsSchema = _artifactsSchema as artifactsSchema;
export const imageArtifactSchema = _imageArtifactSchema as imageArtifactSchema;
export const mainSchema = _mainSchema as mainSchema;
export const sbomSchema = _sbomSchema as sbomSchema;

export interface Artifact extends v.InferInput<typeof artifactSchema> {}
export interface Artifacts extends v.InferInput<typeof artifactsSchema> {}
export interface ImageArtifact extends v.InferInput<
	typeof imageArtifactSchema
> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface Sbom extends v.InferInput<typeof sbomSchema> {}

declare module "@atcute/lexicons/ambient" {
	interface Records {
		"com.emdashcms.experimental.package.release": mainSchema;
	}
}
