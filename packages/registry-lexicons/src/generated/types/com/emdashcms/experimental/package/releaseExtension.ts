import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";

const _commentsAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#commentsAccess",
		),
	),
	/**
	 * Plugin may change comment status with an expected-state precondition. Implies `read`.
	 */
	get moderate() {
		return /*#__PURE__*/ v.optional(commentsModerateConstraintsSchema);
	},
	/**
	 * Plugin may read non-trashed comments and their personal and moderation data.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(commentsReadConstraintsSchema);
	},
});
const _commentsModerateConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#commentsModerateConstraints",
		),
	),
});
const _commentsReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#commentsReadConstraints",
		),
	),
});
const _contentAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentAccess",
		),
	),
	/**
	 * Plugin may inspect and reject publication, scheduling, and unpublication. Does not imply content read or write access.
	 */
	get policy() {
		return /*#__PURE__*/ v.optional(contentPolicyConstraintsSchema);
	},
	/**
	 * Plugin may publish, unpublish, schedule, and unschedule content. Implies `read`.
	 */
	get publish() {
		return /*#__PURE__*/ v.optional(contentPublishConstraintsSchema);
	},
	/**
	 * Plugin may read content records.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(contentReadConstraintsSchema);
	},
	/**
	 * Plugin may read and restore trashed content.
	 */
	get restore() {
		return /*#__PURE__*/ v.optional(contentRestoreConstraintsSchema);
	},
	/**
	 * Plugin may read retained content revision history. Implies `read`.
	 */
	get revisionsRead() {
		return /*#__PURE__*/ v.optional(contentRevisionsReadConstraintsSchema);
	},
	/**
	 * Plugin may create, update, or delete content records. Implies `read`.
	 */
	get write() {
		return /*#__PURE__*/ v.optional(contentWriteConstraintsSchema);
	},
});
const _contentPolicyConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentPolicyConstraints",
		),
	),
});
const _contentPublishConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentPublishConstraints",
		),
	),
});
const _contentReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentReadConstraints",
		),
	),
});
const _contentRestoreConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentRestoreConstraints",
		),
	),
});
const _contentRevisionsReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentRevisionsReadConstraints",
		),
	),
});
const _contentWriteConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentWriteConstraints",
		),
	),
});
const _declaredAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#declaredAccess",
		),
	),
	/**
	 * Access to comment text, author contact and request metadata, and moderation state.
	 */
	get comments() {
		return /*#__PURE__*/ v.optional(commentsAccessSchema);
	},
	/**
	 * Access to site content (posts, pages, custom collections).
	 */
	get content() {
		return /*#__PURE__*/ v.optional(contentAccessSchema);
	},
	/**
	 * Sending mail through the host's mail service, and participating in its delivery pipeline.
	 */
	get email() {
		return /*#__PURE__*/ v.optional(emailAccessSchema);
	},
	/**
	 * Access to uploaded media assets.
	 */
	get media() {
		return /*#__PURE__*/ v.optional(mediaAccessSchema);
	},
	/**
	 * Outbound HTTP requests.
	 */
	get network() {
		return /*#__PURE__*/ v.optional(networkAccessSchema);
	},
	/**
	 * Participation in rendered page output.
	 */
	get page() {
		return /*#__PURE__*/ v.optional(pageAccessSchema);
	},
	/**
	 * Access to visitor redirect rules.
	 */
	get redirects() {
		return /*#__PURE__*/ v.optional(redirectsAccessSchema);
	},
	/**
	 * Read access to collection and field definitions.
	 */
	get schema() {
		return /*#__PURE__*/ v.optional(schemaAccessSchema);
	},
	/**
	 * Access to taxonomy definitions and terms.
	 */
	get taxonomies() {
		return /*#__PURE__*/ v.optional(taxonomiesAccessSchema);
	},
	/**
	 * Access to site user records.
	 */
	get users() {
		return /*#__PURE__*/ v.optional(usersAccessSchema);
	},
});
const _emailAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#emailAccess",
		),
	),
	/**
	 * Plugin observes and may mutate every outgoing message (before and/or after send), including mail from the host and other plugins.
	 */
	get events() {
		return /*#__PURE__*/ v.optional(emailEventsConstraintsSchema);
	},
	/**
	 * Plugin may send mail.
	 */
	get send() {
		return /*#__PURE__*/ v.optional(emailSendConstraintsSchema);
	},
	/**
	 * Plugin becomes the host's mail transport; every message the site sends is delivered through it. Exclusive: installing replaces the current transport.
	 */
	get transport() {
		return /*#__PURE__*/ v.optional(emailTransportConstraintsSchema);
	},
});
const _emailEventsConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#emailEventsConstraints",
		),
	),
});
const _emailSendConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#emailSendConstraints",
		),
	),
});
const _emailTransportConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#emailTransportConstraints",
		),
	),
});
const _mainSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension",
		),
	),
	/**
	 * Structured per-category access manifest. The sandbox enforces every operation declared here at runtime.
	 */
	get declaredAccess() {
		return declaredAccessSchema;
	},
	/**
	 * Optional reference to a provenance document for this release.
	 */
	get provenance() {
		return /*#__PURE__*/ v.optional(provenanceSchema);
	},
});
const _mediaAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#mediaAccess",
		),
	),
	/**
	 * Plugin may read bounded bytes and content hashes for ready media.
	 */
	get bytesRead() {
		return /*#__PURE__*/ v.optional(mediaBytesReadConstraintsSchema);
	},
	/**
	 * Plugin may change alt text, captions, and focal points on ready media.
	 */
	get metadataWrite() {
		return /*#__PURE__*/ v.optional(mediaMetadataWriteConstraintsSchema);
	},
	/**
	 * Plugin may read ready media metadata. Storage keys, author identity, content hashes, and file bytes are excluded.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(mediaReadConstraintsSchema);
	},
	/**
	 * Plugin may upload, modify, or delete media. Implies `read`.
	 */
	get write() {
		return /*#__PURE__*/ v.optional(mediaWriteConstraintsSchema);
	},
});
const _mediaBytesReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#mediaBytesReadConstraints",
		),
	),
});
const _mediaMetadataWriteConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#mediaMetadataWriteConstraints",
		),
	),
});
const _mediaReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#mediaReadConstraints",
		),
	),
});
const _mediaWriteConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#mediaWriteConstraints",
		),
	),
});
const _networkAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#networkAccess",
		),
	),
	/**
	 * Plugin may make outbound HTTP requests. Constraints scope the access; an empty object grants unrestricted requests.
	 */
	get request() {
		return /*#__PURE__*/ v.optional(networkRequestConstraintsSchema);
	},
});
const _networkRequestConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#networkRequestConstraints",
		),
	),
	/**
	 * Allow-list of outbound host patterns. Each entry is a hostname pattern with no scheme, path, or port; a leading '*.' wildcard is permitted for subdomains. Field absent means no host restriction; an empty array MUST NOT appear in records.
	 * @minLength 1
	 * @maxLength 64
	 */
	allowedHosts: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.constrain(
			/*#__PURE__*/ v.array(
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
					/*#__PURE__*/ v.stringLength(0, 256),
				]),
			),
			[/*#__PURE__*/ v.arrayLength(1, 64)],
		),
	),
});
const _pageAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#pageAccess",
		),
	),
	/**
	 * Plugin injects script and/or style fragments into rendered pages.
	 */
	get fragments() {
		return /*#__PURE__*/ v.optional(pageFragmentsConstraintsSchema);
	},
});
const _pageFragmentsConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#pageFragmentsConstraints",
		),
	),
});
const _provenanceSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#provenance",
		),
	),
	/**
	 * @maxLength 1024
	 */
	builderId: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
		/*#__PURE__*/ v.stringLength(0, 1024),
	]),
	/**
	 * Multibase-encoded multihash of the provenance document bytes. Consumers validate the multibase-multihash syntax and supported hash function.
	 * @maxLength 256
	 */
	checksum: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 256),
	]),
	/**
	 * @maxLength 1024
	 */
	predicateType: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [
		/*#__PURE__*/ v.stringLength(0, 1024),
	]),
	/**
	 * @maxLength 1024
	 */
	sourceRepository: /*#__PURE__*/ v.constrain(
		/*#__PURE__*/ v.genericUriString(),
		[/*#__PURE__*/ v.stringLength(0, 1024)],
	),
	/**
	 * @maxLength 2048
	 */
	url: /*#__PURE__*/ v.constrain(/*#__PURE__*/ v.genericUriString(), [
		/*#__PURE__*/ v.stringLength(0, 2048),
	]),
});
const _redirectsAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#redirectsAccess",
		),
	),
	/**
	 * Plugin may read redirect rules.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(redirectsReadConstraintsSchema);
	},
	/**
	 * Plugin may create, update, or delete redirect rules and change where visitors are sent. Implies `read`.
	 */
	get write() {
		return /*#__PURE__*/ v.optional(redirectsWriteConstraintsSchema);
	},
});
const _redirectsReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#redirectsReadConstraints",
		),
	),
});
const _redirectsWriteConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#redirectsWriteConstraints",
		),
	),
});
const _schemaAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#schemaAccess",
		),
	),
	/**
	 * Plugin may read public collection and field definitions.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(schemaReadConstraintsSchema);
	},
});
const _schemaReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#schemaReadConstraints",
		),
	),
});
const _taxonomiesAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#taxonomiesAccess",
		),
	),
	/**
	 * Plugin may read taxonomy definitions, their terms, and the terms assigned to content entries.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(taxonomiesReadConstraintsSchema);
	},
	/**
	 * Plugin may create terms and add or remove term assignments. Implies `read`.
	 */
	get write() {
		return /*#__PURE__*/ v.optional(taxonomiesWriteConstraintsSchema);
	},
});
const _taxonomiesReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#taxonomiesReadConstraints",
		),
	),
});
const _taxonomiesWriteConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#taxonomiesWriteConstraints",
		),
	),
});
const _usersAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#usersAccess",
		),
	),
	/**
	 * Plugin may read site user records.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(usersReadConstraintsSchema);
	},
});
const _usersReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#usersReadConstraints",
		),
	),
});

type commentsAccess$schematype = typeof _commentsAccessSchema;
type commentsModerateConstraints$schematype =
	typeof _commentsModerateConstraintsSchema;
type commentsReadConstraints$schematype = typeof _commentsReadConstraintsSchema;
type contentAccess$schematype = typeof _contentAccessSchema;
type contentPolicyConstraints$schematype =
	typeof _contentPolicyConstraintsSchema;
type contentPublishConstraints$schematype =
	typeof _contentPublishConstraintsSchema;
type contentReadConstraints$schematype = typeof _contentReadConstraintsSchema;
type contentRestoreConstraints$schematype =
	typeof _contentRestoreConstraintsSchema;
type contentRevisionsReadConstraints$schematype =
	typeof _contentRevisionsReadConstraintsSchema;
type contentWriteConstraints$schematype = typeof _contentWriteConstraintsSchema;
type declaredAccess$schematype = typeof _declaredAccessSchema;
type emailAccess$schematype = typeof _emailAccessSchema;
type emailEventsConstraints$schematype = typeof _emailEventsConstraintsSchema;
type emailSendConstraints$schematype = typeof _emailSendConstraintsSchema;
type emailTransportConstraints$schematype =
	typeof _emailTransportConstraintsSchema;
type main$schematype = typeof _mainSchema;
type mediaAccess$schematype = typeof _mediaAccessSchema;
type mediaBytesReadConstraints$schematype =
	typeof _mediaBytesReadConstraintsSchema;
type mediaMetadataWriteConstraints$schematype =
	typeof _mediaMetadataWriteConstraintsSchema;
type mediaReadConstraints$schematype = typeof _mediaReadConstraintsSchema;
type mediaWriteConstraints$schematype = typeof _mediaWriteConstraintsSchema;
type networkAccess$schematype = typeof _networkAccessSchema;
type networkRequestConstraints$schematype =
	typeof _networkRequestConstraintsSchema;
type pageAccess$schematype = typeof _pageAccessSchema;
type pageFragmentsConstraints$schematype =
	typeof _pageFragmentsConstraintsSchema;
type provenance$schematype = typeof _provenanceSchema;
type redirectsAccess$schematype = typeof _redirectsAccessSchema;
type redirectsReadConstraints$schematype =
	typeof _redirectsReadConstraintsSchema;
type redirectsWriteConstraints$schematype =
	typeof _redirectsWriteConstraintsSchema;
type schemaAccess$schematype = typeof _schemaAccessSchema;
type schemaReadConstraints$schematype = typeof _schemaReadConstraintsSchema;
type taxonomiesAccess$schematype = typeof _taxonomiesAccessSchema;
type taxonomiesReadConstraints$schematype =
	typeof _taxonomiesReadConstraintsSchema;
type taxonomiesWriteConstraints$schematype =
	typeof _taxonomiesWriteConstraintsSchema;
type usersAccess$schematype = typeof _usersAccessSchema;
type usersReadConstraints$schematype = typeof _usersReadConstraintsSchema;

export interface commentsAccessSchema extends commentsAccess$schematype {}
export interface commentsModerateConstraintsSchema extends commentsModerateConstraints$schematype {}
export interface commentsReadConstraintsSchema extends commentsReadConstraints$schematype {}
export interface contentAccessSchema extends contentAccess$schematype {}
export interface contentPolicyConstraintsSchema extends contentPolicyConstraints$schematype {}
export interface contentPublishConstraintsSchema extends contentPublishConstraints$schematype {}
export interface contentReadConstraintsSchema extends contentReadConstraints$schematype {}
export interface contentRestoreConstraintsSchema extends contentRestoreConstraints$schematype {}
export interface contentRevisionsReadConstraintsSchema extends contentRevisionsReadConstraints$schematype {}
export interface contentWriteConstraintsSchema extends contentWriteConstraints$schematype {}
export interface declaredAccessSchema extends declaredAccess$schematype {}
export interface emailAccessSchema extends emailAccess$schematype {}
export interface emailEventsConstraintsSchema extends emailEventsConstraints$schematype {}
export interface emailSendConstraintsSchema extends emailSendConstraints$schematype {}
export interface emailTransportConstraintsSchema extends emailTransportConstraints$schematype {}
export interface mainSchema extends main$schematype {}
export interface mediaAccessSchema extends mediaAccess$schematype {}
export interface mediaBytesReadConstraintsSchema extends mediaBytesReadConstraints$schematype {}
export interface mediaMetadataWriteConstraintsSchema extends mediaMetadataWriteConstraints$schematype {}
export interface mediaReadConstraintsSchema extends mediaReadConstraints$schematype {}
export interface mediaWriteConstraintsSchema extends mediaWriteConstraints$schematype {}
export interface networkAccessSchema extends networkAccess$schematype {}
export interface networkRequestConstraintsSchema extends networkRequestConstraints$schematype {}
export interface pageAccessSchema extends pageAccess$schematype {}
export interface pageFragmentsConstraintsSchema extends pageFragmentsConstraints$schematype {}
export interface provenanceSchema extends provenance$schematype {}
export interface redirectsAccessSchema extends redirectsAccess$schematype {}
export interface redirectsReadConstraintsSchema extends redirectsReadConstraints$schematype {}
export interface redirectsWriteConstraintsSchema extends redirectsWriteConstraints$schematype {}
export interface schemaAccessSchema extends schemaAccess$schematype {}
export interface schemaReadConstraintsSchema extends schemaReadConstraints$schematype {}
export interface taxonomiesAccessSchema extends taxonomiesAccess$schematype {}
export interface taxonomiesReadConstraintsSchema extends taxonomiesReadConstraints$schematype {}
export interface taxonomiesWriteConstraintsSchema extends taxonomiesWriteConstraints$schematype {}
export interface usersAccessSchema extends usersAccess$schematype {}
export interface usersReadConstraintsSchema extends usersReadConstraints$schematype {}

export const commentsAccessSchema =
	_commentsAccessSchema as commentsAccessSchema;
export const commentsModerateConstraintsSchema =
	_commentsModerateConstraintsSchema as commentsModerateConstraintsSchema;
export const commentsReadConstraintsSchema =
	_commentsReadConstraintsSchema as commentsReadConstraintsSchema;
export const contentAccessSchema = _contentAccessSchema as contentAccessSchema;
export const contentPolicyConstraintsSchema =
	_contentPolicyConstraintsSchema as contentPolicyConstraintsSchema;
export const contentPublishConstraintsSchema =
	_contentPublishConstraintsSchema as contentPublishConstraintsSchema;
export const contentReadConstraintsSchema =
	_contentReadConstraintsSchema as contentReadConstraintsSchema;
export const contentRestoreConstraintsSchema =
	_contentRestoreConstraintsSchema as contentRestoreConstraintsSchema;
export const contentRevisionsReadConstraintsSchema =
	_contentRevisionsReadConstraintsSchema as contentRevisionsReadConstraintsSchema;
export const contentWriteConstraintsSchema =
	_contentWriteConstraintsSchema as contentWriteConstraintsSchema;
export const declaredAccessSchema =
	_declaredAccessSchema as declaredAccessSchema;
export const emailAccessSchema = _emailAccessSchema as emailAccessSchema;
export const emailEventsConstraintsSchema =
	_emailEventsConstraintsSchema as emailEventsConstraintsSchema;
export const emailSendConstraintsSchema =
	_emailSendConstraintsSchema as emailSendConstraintsSchema;
export const emailTransportConstraintsSchema =
	_emailTransportConstraintsSchema as emailTransportConstraintsSchema;
export const mainSchema = _mainSchema as mainSchema;
export const mediaAccessSchema = _mediaAccessSchema as mediaAccessSchema;
export const mediaBytesReadConstraintsSchema =
	_mediaBytesReadConstraintsSchema as mediaBytesReadConstraintsSchema;
export const mediaMetadataWriteConstraintsSchema =
	_mediaMetadataWriteConstraintsSchema as mediaMetadataWriteConstraintsSchema;
export const mediaReadConstraintsSchema =
	_mediaReadConstraintsSchema as mediaReadConstraintsSchema;
export const mediaWriteConstraintsSchema =
	_mediaWriteConstraintsSchema as mediaWriteConstraintsSchema;
export const networkAccessSchema = _networkAccessSchema as networkAccessSchema;
export const networkRequestConstraintsSchema =
	_networkRequestConstraintsSchema as networkRequestConstraintsSchema;
export const pageAccessSchema = _pageAccessSchema as pageAccessSchema;
export const pageFragmentsConstraintsSchema =
	_pageFragmentsConstraintsSchema as pageFragmentsConstraintsSchema;
export const provenanceSchema = _provenanceSchema as provenanceSchema;
export const redirectsAccessSchema =
	_redirectsAccessSchema as redirectsAccessSchema;
export const redirectsReadConstraintsSchema =
	_redirectsReadConstraintsSchema as redirectsReadConstraintsSchema;
export const redirectsWriteConstraintsSchema =
	_redirectsWriteConstraintsSchema as redirectsWriteConstraintsSchema;
export const schemaAccessSchema = _schemaAccessSchema as schemaAccessSchema;
export const schemaReadConstraintsSchema =
	_schemaReadConstraintsSchema as schemaReadConstraintsSchema;
export const taxonomiesAccessSchema =
	_taxonomiesAccessSchema as taxonomiesAccessSchema;
export const taxonomiesReadConstraintsSchema =
	_taxonomiesReadConstraintsSchema as taxonomiesReadConstraintsSchema;
export const taxonomiesWriteConstraintsSchema =
	_taxonomiesWriteConstraintsSchema as taxonomiesWriteConstraintsSchema;
export const usersAccessSchema = _usersAccessSchema as usersAccessSchema;
export const usersReadConstraintsSchema =
	_usersReadConstraintsSchema as usersReadConstraintsSchema;

export interface CommentsAccess extends v.InferInput<
	typeof commentsAccessSchema
> {}
export interface CommentsModerateConstraints extends v.InferInput<
	typeof commentsModerateConstraintsSchema
> {}
export interface CommentsReadConstraints extends v.InferInput<
	typeof commentsReadConstraintsSchema
> {}
export interface ContentAccess extends v.InferInput<
	typeof contentAccessSchema
> {}
export interface ContentPolicyConstraints extends v.InferInput<
	typeof contentPolicyConstraintsSchema
> {}
export interface ContentPublishConstraints extends v.InferInput<
	typeof contentPublishConstraintsSchema
> {}
export interface ContentReadConstraints extends v.InferInput<
	typeof contentReadConstraintsSchema
> {}
export interface ContentRestoreConstraints extends v.InferInput<
	typeof contentRestoreConstraintsSchema
> {}
export interface ContentRevisionsReadConstraints extends v.InferInput<
	typeof contentRevisionsReadConstraintsSchema
> {}
export interface ContentWriteConstraints extends v.InferInput<
	typeof contentWriteConstraintsSchema
> {}
export interface DeclaredAccess extends v.InferInput<
	typeof declaredAccessSchema
> {}
export interface EmailAccess extends v.InferInput<typeof emailAccessSchema> {}
export interface EmailEventsConstraints extends v.InferInput<
	typeof emailEventsConstraintsSchema
> {}
export interface EmailSendConstraints extends v.InferInput<
	typeof emailSendConstraintsSchema
> {}
export interface EmailTransportConstraints extends v.InferInput<
	typeof emailTransportConstraintsSchema
> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface MediaAccess extends v.InferInput<typeof mediaAccessSchema> {}
export interface MediaBytesReadConstraints extends v.InferInput<
	typeof mediaBytesReadConstraintsSchema
> {}
export interface MediaMetadataWriteConstraints extends v.InferInput<
	typeof mediaMetadataWriteConstraintsSchema
> {}
export interface MediaReadConstraints extends v.InferInput<
	typeof mediaReadConstraintsSchema
> {}
export interface MediaWriteConstraints extends v.InferInput<
	typeof mediaWriteConstraintsSchema
> {}
export interface NetworkAccess extends v.InferInput<
	typeof networkAccessSchema
> {}
export interface NetworkRequestConstraints extends v.InferInput<
	typeof networkRequestConstraintsSchema
> {}
export interface PageAccess extends v.InferInput<typeof pageAccessSchema> {}
export interface PageFragmentsConstraints extends v.InferInput<
	typeof pageFragmentsConstraintsSchema
> {}
export interface Provenance extends v.InferInput<typeof provenanceSchema> {}
export interface RedirectsAccess extends v.InferInput<
	typeof redirectsAccessSchema
> {}
export interface RedirectsReadConstraints extends v.InferInput<
	typeof redirectsReadConstraintsSchema
> {}
export interface RedirectsWriteConstraints extends v.InferInput<
	typeof redirectsWriteConstraintsSchema
> {}
export interface SchemaAccess extends v.InferInput<typeof schemaAccessSchema> {}
export interface SchemaReadConstraints extends v.InferInput<
	typeof schemaReadConstraintsSchema
> {}
export interface TaxonomiesAccess extends v.InferInput<
	typeof taxonomiesAccessSchema
> {}
export interface TaxonomiesReadConstraints extends v.InferInput<
	typeof taxonomiesReadConstraintsSchema
> {}
export interface TaxonomiesWriteConstraints extends v.InferInput<
	typeof taxonomiesWriteConstraintsSchema
> {}
export interface UsersAccess extends v.InferInput<typeof usersAccessSchema> {}
export interface UsersReadConstraints extends v.InferInput<
	typeof usersReadConstraintsSchema
> {}
