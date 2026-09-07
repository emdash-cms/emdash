import { parseSubjectUri } from "../assessment/run-key.js";
import type { AssessmentSubjectKind } from "../assessment/types.js";

const PROFILE_COLLECTION = "com.emdashcms.experimental.package.profile";
const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";
const DID_RE = /^did:(?:plc|web):[A-Za-z0-9._:%-]+$/;
const CANONICAL_CID_RE = /^b[a-z2-7]{7,255}$/;

export interface DiscoveryUpsertHint {
	operation: "upsert";
	uri: string;
	cid: string;
	kind: AssessmentSubjectKind;
}

export interface DiscoveryDeleteHint {
	operation: "delete";
	uri: string;
	kind: AssessmentSubjectKind;
}

export type DiscoveryHint = DiscoveryUpsertHint | DiscoveryDeleteHint;

export interface DiscoveryStreamItem {
	cursor: string;
	eventId?: string;
	orderKey?: string;
	event: unknown;
}

export function parseDiscoveryEvent(value: unknown): DiscoveryHint | null {
	if (!isPlainObject(value) || value["kind"] !== "commit" || !isPlainObject(value["commit"])) {
		return null;
	}
	const did = value["did"];
	const commit = value["commit"];
	const collection = commit["collection"];
	const rkey = commit["rkey"];
	const operation = commit["operation"];
	if (typeof did !== "string" || !DID_RE.test(did))
		throw new TypeError("discovery event DID is invalid");
	if (collection !== PROFILE_COLLECTION && collection !== RELEASE_COLLECTION) return null;
	if (
		typeof rkey !== "string" ||
		rkey.length === 0 ||
		rkey.length > 512 ||
		rkey.includes("/") ||
		rkey.includes("?") ||
		rkey.includes("#")
	) {
		throw new TypeError("discovery event record key is invalid");
	}
	const uri = `at://${did}/${collection}/${rkey}`;
	const kind = parseSubjectUri(uri).kind;
	if (operation === "delete") return { operation: "delete", uri, kind };
	if (operation !== "create" && operation !== "update") {
		throw new TypeError("discovery event operation is invalid");
	}
	const cid = commit["cid"];
	if (typeof cid !== "string" || !CANONICAL_CID_RE.test(cid)) {
		throw new TypeError("discovery event CID is invalid");
	}
	return { operation: "upsert", uri, cid, kind };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
