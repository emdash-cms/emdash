import type { AssessmentSubject, AssessmentVersionSet, AssessmentWorkflowParams } from "./types.js";

const RUN_KEY_PREFIX = "assessment-v1-";
const SHA256_HEX_LENGTH = 64;
const VERSION_VALUE_RE = /^[\x21-\x7e]{1,256}$/;
const CID_RE = /^[a-z0-9]{8,256}$/;
const DID_RE = /^did:(?:plc|web):[A-Za-z0-9._:%-]+$/;

export interface AssessmentRunIdentity {
	subject: AssessmentSubject;
	versions: AssessmentVersionSet;
	logicalTriggerId: string;
}

export async function createAssessmentRunKey(identity: AssessmentRunIdentity): Promise<string> {
	assertAssessmentRunIdentity(identity);
	const encoded = JSON.stringify([
		1,
		identity.subject.uri,
		identity.subject.cid,
		identity.subject.kind,
		identity.versions.policyVersion,
		identity.versions.parserVersion,
		identity.versions.textModelId,
		identity.versions.textPromptHash,
		identity.versions.imageModelId,
		identity.versions.imagePromptHash,
		identity.logicalTriggerId,
	]);
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded)),
	);
	return `${RUN_KEY_PREFIX}${toHex(digest)}`;
}

export async function createAssessmentWorkflowParams(
	identity: AssessmentRunIdentity,
): Promise<AssessmentWorkflowParams> {
	return {
		runKey: await createAssessmentRunKey(identity),
		subjectUri: identity.subject.uri,
		subjectCid: identity.subject.cid,
		subjectKind: identity.subject.kind,
		...identity.versions,
		logicalTriggerId: identity.logicalTriggerId,
	};
}

export async function assertAssessmentWorkflowParams(
	params: AssessmentWorkflowParams,
): Promise<void> {
	if (
		!params.runKey.startsWith(RUN_KEY_PREFIX) ||
		params.runKey.length !== RUN_KEY_PREFIX.length + SHA256_HEX_LENGTH
	) {
		throw new TypeError("assessment Workflow run key is malformed");
	}
	const identity = workflowParamsToIdentity(params);
	if ((await createAssessmentRunKey(identity)) !== params.runKey) {
		throw new TypeError("assessment Workflow run key does not match its inputs");
	}
}

export function workflowParamsToIdentity(params: AssessmentWorkflowParams): AssessmentRunIdentity {
	const required = {
		policyVersion: requireWorkflowField(params.policyVersion, "policyVersion"),
		parserVersion: requireWorkflowField(params.parserVersion, "parserVersion"),
		textModelId: requireWorkflowField(params.textModelId, "textModelId"),
		textPromptHash: requireWorkflowField(params.textPromptHash, "textPromptHash"),
		imageModelId: requireWorkflowField(params.imageModelId, "imageModelId"),
		imagePromptHash: requireWorkflowField(params.imagePromptHash, "imagePromptHash"),
		logicalTriggerId: requireWorkflowField(params.logicalTriggerId, "logicalTriggerId"),
	};
	return {
		subject: {
			uri: params.subjectUri,
			cid: params.subjectCid,
			kind: params.subjectKind,
		},
		versions: {
			policyVersion: required.policyVersion,
			parserVersion: required.parserVersion,
			textModelId: required.textModelId,
			textPromptHash: required.textPromptHash,
			imageModelId: required.imageModelId,
			imagePromptHash: required.imagePromptHash,
		},
		logicalTriggerId: required.logicalTriggerId,
	};
}

function requireWorkflowField(value: string | undefined, field: string): string {
	if (value === undefined) throw new TypeError(`assessment Workflow ${field} is required`);
	return value;
}

export function assertAssessmentRunIdentity(identity: AssessmentRunIdentity): void {
	const parsed = parseSubjectUri(identity.subject.uri);
	if (parsed.kind !== identity.subject.kind) {
		throw new TypeError("assessment subject URI collection does not match its kind");
	}
	if (!CID_RE.test(identity.subject.cid))
		throw new TypeError("assessment subject CID is malformed");
	for (const [field, value] of Object.entries({
		...identity.versions,
		logicalTriggerId: identity.logicalTriggerId,
	})) {
		if (!VERSION_VALUE_RE.test(value)) throw new TypeError(`assessment ${field} is malformed`);
	}
}

export function parseSubjectUri(uri: string): {
	publisherDid: string;
	collection: string;
	rkey: string;
	kind: AssessmentSubject["kind"];
} {
	if (!uri.startsWith("at://")) throw new TypeError("assessment subject URI must be an AT URI");
	const parts = uri.slice(5).split("/");
	if (parts.length !== 3) throw new TypeError("assessment subject URI must identify one record");
	const [publisherDid, collection, rkey] = parts;
	if (!publisherDid || !DID_RE.test(publisherDid)) {
		throw new TypeError("assessment subject URI has an invalid publisher DID");
	}
	if (!rkey || rkey.includes("?") || rkey.includes("#")) {
		throw new TypeError("assessment subject URI has an invalid record key");
	}
	if (collection === "com.emdashcms.experimental.package.profile") {
		return { publisherDid, collection, rkey, kind: "profile" };
	}
	if (collection === "com.emdashcms.experimental.package.release") {
		return { publisherDid, collection, rkey, kind: "release" };
	}
	throw new TypeError("assessment subject URI targets an unsupported collection");
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
