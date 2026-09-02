import { PROFILE_COLLECTION, RELEASE_COLLECTION, type ListingSubjectKind } from "./labels.js";
import {
	dictionary,
	integerValue,
	optionalBoolean,
	optionalInteger,
	optionalString,
	record,
	runtimeSchema,
	stringArray,
	stringValue,
} from "./schema.js";
import { assertCanonicalCid, assertDid, parseAtUri } from "./validation.js";

export interface ModerationSubject {
	uri: string;
	cid: string;
	kind: ListingSubjectKind;
}

export interface CanonicalAuthorInput {
	name: string;
	url?: string;
	email?: string;
}

export interface CanonicalContactInput {
	url?: string;
	email?: string;
}

export interface CanonicalProfileModerationInput {
	schemaVersion: 1;
	subject: ModerationSubject & { kind: "profile" };
	publisherDid: string;
	slug: string;
	name?: string;
	description?: string;
	keywords: readonly string[];
	license: string;
	sections: Readonly<Record<string, string>>;
	authors: readonly CanonicalAuthorInput[];
	security: readonly CanonicalContactInput[];
	lastUpdated?: string;
}

export type DisplayMediaKind = "icon" | "banner" | "screenshot";
export const RENDERED_PROFILE_SECTION_KEYS = [
	"description",
	"installation",
	"faq",
	"changelog",
	"security",
] as const;

export interface CanonicalMediaDescriptor {
	kind: DisplayMediaKind;
	index: number;
	id?: string;
	url: string;
	checksum: string;
	contentType?: string;
	requiresAuth?: boolean;
	releaseAsset?: boolean;
	width?: number;
	height?: number;
	language?: string;
	verified?: {
		sha256: string;
		mimeType: string;
		byteLength: number;
		width: number;
		height: number;
		contentRef: string;
	};
}

export interface CanonicalReleaseModerationInput {
	schemaVersion: 1;
	subject: ModerationSubject & { kind: "release" };
	publisherDid: string;
	packageSlug: string;
	version: string;
	repositoryUrl?: string;
	requires: Readonly<Record<string, string>>;
	sbom?: { format?: string; url?: string };
	media: readonly CanonicalMediaDescriptor[];
}

function parseSubject(
	value: unknown,
	kind: "profile",
	publisherDid: string,
): ModerationSubject & { kind: "profile" };
function parseSubject(
	value: unknown,
	kind: "release",
	publisherDid: string,
): ModerationSubject & { kind: "release" };
function parseSubject(
	value: unknown,
	kind: ListingSubjectKind,
	publisherDid: string,
): ModerationSubject {
	const subject = record(value, "subject", ["uri", "cid", "kind"]);
	const uri = stringValue(subject["uri"], "subject.uri", 2048);
	const cid = stringValue(subject["cid"], "subject.cid", 256);
	if (subject["kind"] !== kind) throw new TypeError(`subject.kind must be ${kind}`);
	const expectedCollection = kind === "profile" ? PROFILE_COLLECTION : RELEASE_COLLECTION;
	const parsed = parseAtUri(uri, "subject.uri");
	if (parsed.authority !== publisherDid) {
		throw new TypeError("subject.uri authority must match publisherDid");
	}
	if (parsed.collection !== expectedCollection) {
		throw new TypeError(`subject.uri must target ${expectedCollection}`);
	}
	assertCanonicalCid(cid, "subject.cid");
	return { uri, cid, kind };
}

function parsePublisherDid(value: unknown): string {
	const publisherDid = stringValue(value, "publisherDid", 256);
	assertDid(publisherDid, "publisherDid");
	return publisherDid;
}

function parseAuthors(value: unknown): CanonicalAuthorInput[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		throw new TypeError("authors must contain between 1 and 32 entries");
	}
	return value.map((entry, index) => {
		const author = record(entry, `authors[${index}]`, ["name", "url", "email"]);
		return {
			name: stringValue(author["name"], `authors[${index}].name`, 256),
			url: optionalString(author["url"], `authors[${index}].url`, 1024),
			email: optionalString(author["email"], `authors[${index}].email`, 256),
		};
	});
}

function parseContacts(value: unknown): CanonicalContactInput[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
		throw new TypeError("security must contain between 1 and 8 entries");
	}
	return value.map((entry, index) => {
		const contact = record(entry, `security[${index}]`, ["url", "email"]);
		const parsed = {
			url: optionalString(contact["url"], `security[${index}].url`, 1024),
			email: optionalString(contact["email"], `security[${index}].email`, 256),
		};
		if (!parsed.url && !parsed.email) {
			throw new TypeError(`security[${index}] must contain url or email`);
		}
		return parsed;
	});
}

function parseStringRecord(
	value: unknown,
	field: string,
	maxItems: number,
	allowedKeys?: readonly string[],
): Record<string, string> {
	const source = dictionary(value, field);
	const entries = Object.entries(source);
	if (entries.length > maxItems) throw new TypeError(`${field} has too many entries`);
	if (allowedKeys && entries.some(([key]) => !allowedKeys.includes(key))) {
		throw new TypeError(`${field} contains a field that official clients do not render`);
	}
	return Object.fromEntries(
		entries.map(([key, item]) => [
			stringValue(key, `${field} key`, 128),
			stringValue(item, `${field}.${key}`),
		]),
	);
}

function parseProfile(value: unknown): CanonicalProfileModerationInput {
	const profile = record(value, "profile input", [
		"schemaVersion",
		"subject",
		"publisherDid",
		"slug",
		"name",
		"description",
		"keywords",
		"license",
		"sections",
		"authors",
		"security",
		"lastUpdated",
	]);
	if (profile["schemaVersion"] !== 1) throw new TypeError("schemaVersion must be 1");
	const publisherDid = parsePublisherDid(profile["publisherDid"]);
	const subject = parseSubject(profile["subject"], "profile", publisherDid);
	const slug = stringValue(profile["slug"], "slug", 64);
	if (parseAtUri(subject.uri, "subject.uri").rkey !== slug) {
		throw new TypeError("slug must match the profile record key");
	}
	return {
		schemaVersion: 1,
		subject,
		publisherDid,
		slug,
		name: optionalString(profile["name"], "name", 1024),
		description: optionalString(profile["description"], "description", 1024),
		keywords: stringArray(profile["keywords"], "keywords", 5),
		license: stringValue(profile["license"], "license", 256),
		sections: parseStringRecord(
			profile["sections"],
			"sections",
			RENDERED_PROFILE_SECTION_KEYS.length,
			RENDERED_PROFILE_SECTION_KEYS,
		),
		authors: parseAuthors(profile["authors"]),
		security: parseContacts(profile["security"]),
		lastUpdated: optionalString(profile["lastUpdated"], "lastUpdated", 64),
	};
}

function parseVerifiedMedia(value: unknown, field: string): CanonicalMediaDescriptor["verified"] {
	if (value === undefined) return undefined;
	const verified = record(value, field, [
		"sha256",
		"mimeType",
		"byteLength",
		"width",
		"height",
		"contentRef",
	]);
	return {
		sha256: stringValue(verified["sha256"], `${field}.sha256`, 128),
		mimeType: stringValue(verified["mimeType"], `${field}.mimeType`, 256),
		byteLength: integerValue(verified["byteLength"], `${field}.byteLength`),
		width: integerValue(verified["width"], `${field}.width`),
		height: integerValue(verified["height"], `${field}.height`),
		contentRef: stringValue(verified["contentRef"], `${field}.contentRef`, 512),
	};
}

function parseMedia(value: unknown): CanonicalMediaDescriptor[] {
	if (!Array.isArray(value) || value.length > 10) {
		throw new TypeError("media must be an array of at most 10 entries");
	}
	const parsed = value.map((entry, index) => {
		const field = `media[${index}]`;
		const media = record(entry, field, [
			"kind",
			"index",
			"id",
			"url",
			"checksum",
			"contentType",
			"requiresAuth",
			"releaseAsset",
			"width",
			"height",
			"language",
			"verified",
		]);
		const kind = media["kind"];
		if (!isDisplayMediaKind(kind)) {
			throw new TypeError(`${field}.kind is not display media`);
		}
		return {
			kind,
			index: integerValue(media["index"], `${field}.index`),
			id: optionalString(media["id"], `${field}.id`, 128),
			url: stringValue(media["url"], `${field}.url`, 2048),
			checksum: stringValue(media["checksum"], `${field}.checksum`, 256),
			contentType: optionalString(media["contentType"], `${field}.contentType`, 256),
			requiresAuth: optionalBoolean(media["requiresAuth"], `${field}.requiresAuth`),
			releaseAsset: optionalBoolean(media["releaseAsset"], `${field}.releaseAsset`),
			width: optionalInteger(media["width"], `${field}.width`),
			height: optionalInteger(media["height"], `${field}.height`),
			language: optionalString(media["language"], `${field}.language`, 64),
			verified: parseVerifiedMedia(media["verified"], `${field}.verified`),
		};
	});
	const keys = parsed.map((media) => `${media.kind}:${media.index}`);
	if (new Set(keys).size !== keys.length) throw new TypeError("media entries must be unique");
	if (parsed.filter((media) => media.kind === "icon").length > 1) {
		throw new TypeError("media may contain at most one icon");
	}
	if (parsed.filter((media) => media.kind === "banner").length > 1) {
		throw new TypeError("media may contain at most one banner");
	}
	if (parsed.filter((media) => media.kind === "screenshot").length > 8) {
		throw new TypeError("media may contain at most eight screenshots");
	}
	if (parsed.some((media) => media.kind !== "screenshot" && media.index !== 0)) {
		throw new TypeError("icon and banner media indices must be zero");
	}
	return parsed;
}

function parseRelease(value: unknown): CanonicalReleaseModerationInput {
	const release = record(value, "release input", [
		"schemaVersion",
		"subject",
		"publisherDid",
		"packageSlug",
		"version",
		"repositoryUrl",
		"requires",
		"sbom",
		"media",
	]);
	if (release["schemaVersion"] !== 1) throw new TypeError("schemaVersion must be 1");
	const publisherDid = parsePublisherDid(release["publisherDid"]);
	const subject = parseSubject(release["subject"], "release", publisherDid);
	const packageSlug = stringValue(release["packageSlug"], "packageSlug", 64);
	const version = stringValue(release["version"], "version", 64);
	if (parseAtUri(subject.uri, "subject.uri").rkey !== `${packageSlug}:${version}`) {
		throw new TypeError("packageSlug and version must match the release record key");
	}
	let sbom: CanonicalReleaseModerationInput["sbom"];
	if (release["sbom"] !== undefined) {
		const source = record(release["sbom"], "sbom", ["format", "url"]);
		sbom = {
			format: optionalString(source["format"], "sbom.format", 32),
			url: optionalString(source["url"], "sbom.url", 2048),
		};
	}
	return {
		schemaVersion: 1,
		subject,
		publisherDid,
		packageSlug,
		version,
		repositoryUrl: optionalString(release["repositoryUrl"], "repositoryUrl", 1024),
		requires: parseStringRecord(release["requires"], "requires", 64),
		sbom,
		media: parseMedia(release["media"]),
	};
}

export const CanonicalProfileModerationInputSchema = runtimeSchema(parseProfile);
export const CanonicalReleaseModerationInputSchema = runtimeSchema(parseRelease);

function isDisplayMediaKind(value: unknown): value is DisplayMediaKind {
	return value === "icon" || value === "banner" || value === "screenshot";
}
