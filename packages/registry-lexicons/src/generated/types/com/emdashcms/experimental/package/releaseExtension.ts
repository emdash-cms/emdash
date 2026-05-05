import type {} from "@atcute/lexicons";
import * as v from "@atcute/lexicons/validations";

const _contentAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension#contentAccess"),
	),
	/**
	 * Plugin may read content records.
	 */
	get read() {
		return /*#__PURE__*/ v.optional(contentReadConstraintsSchema);
	},
	/**
	 * Plugin may create, update, or delete content records. Implies `read`.
	 */
	get write() {
		return /*#__PURE__*/ v.optional(contentWriteConstraintsSchema);
	},
});
const _contentReadConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#contentReadConstraints",
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
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension#declaredAccess"),
	),
	/**
	 * Access to site content (posts, pages, custom collections).
	 */
	get content() {
		return /*#__PURE__*/ v.optional(contentAccessSchema);
	},
	/**
	 * Sending mail through the host's mail service.
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
});
const _emailAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension#emailAccess"),
	),
	/**
	 * Plugin may send mail.
	 */
	get send() {
		return /*#__PURE__*/ v.optional(emailSendConstraintsSchema);
	},
});
const _emailSendConstraintsSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal(
			"com.emdashcms.experimental.package.releaseExtension#emailSendConstraints",
		),
	),
});
const _mainSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension"),
	),
	/**
	 * Structured per-category access manifest. The sandbox enforces every operation declared here at runtime.
	 */
	get declaredAccess() {
		return declaredAccessSchema;
	},
});
const _mediaAccessSchema = /*#__PURE__*/ v.object({
	$type: /*#__PURE__*/ v.optional(
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension#mediaAccess"),
	),
	/**
	 * Plugin may read media metadata and fetch media bytes.
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
		/*#__PURE__*/ v.literal("com.emdashcms.experimental.package.releaseExtension#networkAccess"),
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
				/*#__PURE__*/ v.constrain(/*#__PURE__*/ v.string(), [/*#__PURE__*/ v.stringLength(0, 256)]),
			),
			[/*#__PURE__*/ v.arrayLength(1, 64)],
		),
	),
});

type contentAccess$schematype = typeof _contentAccessSchema;
type contentReadConstraints$schematype = typeof _contentReadConstraintsSchema;
type contentWriteConstraints$schematype = typeof _contentWriteConstraintsSchema;
type declaredAccess$schematype = typeof _declaredAccessSchema;
type emailAccess$schematype = typeof _emailAccessSchema;
type emailSendConstraints$schematype = typeof _emailSendConstraintsSchema;
type main$schematype = typeof _mainSchema;
type mediaAccess$schematype = typeof _mediaAccessSchema;
type mediaReadConstraints$schematype = typeof _mediaReadConstraintsSchema;
type mediaWriteConstraints$schematype = typeof _mediaWriteConstraintsSchema;
type networkAccess$schematype = typeof _networkAccessSchema;
type networkRequestConstraints$schematype = typeof _networkRequestConstraintsSchema;

export interface contentAccessSchema extends contentAccess$schematype {}
export interface contentReadConstraintsSchema extends contentReadConstraints$schematype {}
export interface contentWriteConstraintsSchema extends contentWriteConstraints$schematype {}
export interface declaredAccessSchema extends declaredAccess$schematype {}
export interface emailAccessSchema extends emailAccess$schematype {}
export interface emailSendConstraintsSchema extends emailSendConstraints$schematype {}
export interface mainSchema extends main$schematype {}
export interface mediaAccessSchema extends mediaAccess$schematype {}
export interface mediaReadConstraintsSchema extends mediaReadConstraints$schematype {}
export interface mediaWriteConstraintsSchema extends mediaWriteConstraints$schematype {}
export interface networkAccessSchema extends networkAccess$schematype {}
export interface networkRequestConstraintsSchema extends networkRequestConstraints$schematype {}

export const contentAccessSchema = _contentAccessSchema as contentAccessSchema;
export const contentReadConstraintsSchema =
	_contentReadConstraintsSchema as contentReadConstraintsSchema;
export const contentWriteConstraintsSchema =
	_contentWriteConstraintsSchema as contentWriteConstraintsSchema;
export const declaredAccessSchema = _declaredAccessSchema as declaredAccessSchema;
export const emailAccessSchema = _emailAccessSchema as emailAccessSchema;
export const emailSendConstraintsSchema = _emailSendConstraintsSchema as emailSendConstraintsSchema;
export const mainSchema = _mainSchema as mainSchema;
export const mediaAccessSchema = _mediaAccessSchema as mediaAccessSchema;
export const mediaReadConstraintsSchema = _mediaReadConstraintsSchema as mediaReadConstraintsSchema;
export const mediaWriteConstraintsSchema =
	_mediaWriteConstraintsSchema as mediaWriteConstraintsSchema;
export const networkAccessSchema = _networkAccessSchema as networkAccessSchema;
export const networkRequestConstraintsSchema =
	_networkRequestConstraintsSchema as networkRequestConstraintsSchema;

export interface ContentAccess extends v.InferInput<typeof contentAccessSchema> {}
export interface ContentReadConstraints extends v.InferInput<typeof contentReadConstraintsSchema> {}
export interface ContentWriteConstraints extends v.InferInput<
	typeof contentWriteConstraintsSchema
> {}
export interface DeclaredAccess extends v.InferInput<typeof declaredAccessSchema> {}
export interface EmailAccess extends v.InferInput<typeof emailAccessSchema> {}
export interface EmailSendConstraints extends v.InferInput<typeof emailSendConstraintsSchema> {}
export interface Main extends v.InferInput<typeof mainSchema> {}
export interface MediaAccess extends v.InferInput<typeof mediaAccessSchema> {}
export interface MediaReadConstraints extends v.InferInput<typeof mediaReadConstraintsSchema> {}
export interface MediaWriteConstraints extends v.InferInput<typeof mediaWriteConstraintsSchema> {}
export interface NetworkAccess extends v.InferInput<typeof networkAccessSchema> {}
export interface NetworkRequestConstraints extends v.InferInput<
	typeof networkRequestConstraintsSchema
> {}
