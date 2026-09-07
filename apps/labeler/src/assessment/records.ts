import {
	getPublicKeyFromDidController,
	P256PublicKey,
	Secp256k1PublicKey,
	type PublicKey,
} from "@atcute/crypto";
import { type DidDocument, getAtprotoVerificationMaterial, getPdsEndpoint } from "@atcute/identity";
import { type AtprotoDid, isDid } from "@atcute/lexicons/syntax";
import { safeParse } from "@atcute/lexicons/validations";
import { verifyRecord } from "@atcute/repo";
import {
	PackageProfile,
	PackageRelease,
	type RegistryRecords,
} from "@emdash-cms/registry-lexicons";
import {
	fetchVerifiedResource,
	type FetchImplementation,
	type HostnameResolver,
} from "@emdash-cms/registry-verification/fetch";

import { parseSubjectUri } from "./run-key.js";
import type { AssessmentSubject } from "./types.js";

export type VerifiedProfileRecord = ExactVerifiedRecord<
	"profile",
	RegistryRecords["com.emdashcms.experimental.package.profile"]
>;
export type VerifiedReleaseRecord = ExactVerifiedRecord<
	"release",
	RegistryRecords["com.emdashcms.experimental.package.release"]
>;
export type VerifiedRegistryRecord = VerifiedProfileRecord | VerifiedReleaseRecord;

export interface ExactVerifiedRecord<Kind extends AssessmentSubject["kind"], Record> {
	uri: string;
	cid: string;
	kind: Kind;
	record: Record;
	verification: "did-mst-signature";
}

export interface ExactRecordVerifier {
	verifyExactRecord(subject: AssessmentSubject): Promise<{
		uri: string;
		cid: string;
		record: unknown;
		verification: "did-mst-signature";
	}>;
}

export interface FetchRecordProofInput {
	pds: string;
	did: AtprotoDid;
	collection: string;
	rkey: string;
	publicKey: PublicKey;
}

export interface CreateAtprotoExactRecordVerifierInput {
	resolveDid(did: AtprotoDid): Promise<DidDocument>;
	fetchRecordProof?(input: FetchRecordProofInput): Promise<{ cid: string; record: unknown }>;
	fetch?: FetchImplementation;
	resolveHostname?: HostnameResolver;
}

export function createAtprotoExactRecordVerifier(
	input: CreateAtprotoExactRecordVerifierInput,
): ExactRecordVerifier {
	return {
		async verifyExactRecord(subject) {
			const parsed = parseSubjectUri(subject.uri);
			const did = asAtprotoDid(parsed.publisherDid);
			const document = await input.resolveDid(did);
			if (document.id !== did)
				throw new Error("resolved DID document does not match the publisher");
			const pds = getPdsEndpoint(document);
			if (!pds) throw new Error("publisher DID document has no AT Protocol PDS service");
			const material = getAtprotoVerificationMaterial(document);
			if (!material) throw new Error("publisher DID document has no AT Protocol signing key");
			const publicKey = await materializePublicKey(material.publicKeyMultibase);
			const proof = await (
				input.fetchRecordProof ?? ((proofInput) => fetchAndVerifyRecordProof(proofInput, input))
			)({
				pds,
				did,
				collection: parsed.collection,
				rkey: parsed.rkey,
				publicKey,
			});
			if (proof.cid !== subject.cid) {
				throw new Error("verified publisher record does not match the exact CID");
			}
			return {
				uri: subject.uri,
				cid: proof.cid,
				record: proof.record,
				verification: "did-mst-signature",
			};
		},
	};
}

export async function verifyExactRegistryRecord(
	verifier: ExactRecordVerifier,
	subject: AssessmentSubject,
): Promise<VerifiedRegistryRecord> {
	const verified = await verifier.verifyExactRecord(subject);
	return validateExactRegistryRecord(subject, verified);
}

export function validateExactRegistryRecord(
	subject: AssessmentSubject,
	verified: Awaited<ReturnType<ExactRecordVerifier["verifyExactRecord"]>>,
): VerifiedRegistryRecord {
	if (verified.uri !== subject.uri || verified.cid !== subject.cid) {
		throw new Error("verified publisher record does not match the requested URI and CID");
	}
	const parsed = parseSubjectUri(subject.uri);
	if (subject.kind !== parsed.kind) {
		throw new TypeError("assessment subject kind does not match its collection");
	}

	if (subject.kind === "profile") {
		const validation = safeParse(PackageProfile.mainSchema, verified.record);
		if (!validation.ok) throw new TypeError("verified profile record failed lexicon validation");
		if (validation.value.id !== subject.uri) {
			throw new TypeError("verified profile id does not match its record URI");
		}
		if (validation.value.slug !== undefined && validation.value.slug !== parsed.rkey) {
			throw new TypeError("verified profile slug does not match its record key");
		}
		if (validation.value.security.some((contact) => !contact.url && !contact.email)) {
			throw new TypeError("verified profile security contacts require a URL or email address");
		}
		return {
			uri: verified.uri,
			cid: verified.cid,
			kind: "profile",
			record: validation.value,
			verification: verified.verification,
		};
	}

	const validation = safeParse(PackageRelease.mainSchema, verified.record);
	if (!validation.ok) throw new TypeError("verified release record failed lexicon validation");
	if (parsed.rkey !== `${validation.value.package}:${validation.value.version}`) {
		throw new TypeError("verified release package and version do not match its record key");
	}
	return {
		uri: verified.uri,
		cid: verified.cid,
		kind: "release",
		record: validation.value,
		verification: verified.verification,
	};
}

async function fetchAndVerifyRecordProof(
	proof: FetchRecordProofInput,
	options: Pick<CreateAtprotoExactRecordVerifierInput, "fetch" | "resolveHostname">,
): Promise<{ cid: string; record: unknown }> {
	if (!options.resolveHostname) {
		throw new TypeError("production record verification requires a hostname resolver");
	}
	const url = new URL("/xrpc/com.atproto.sync.getRecord", proof.pds);
	url.searchParams.set("did", proof.did);
	url.searchParams.set("collection", proof.collection);
	url.searchParams.set("rkey", proof.rkey);
	const fetched = await fetchVerifiedResource(url, {
		fetch: options.fetch ?? ((resource, init) => globalThis.fetch(resource, init)),
		resolveHostname: options.resolveHostname,
		maxBytes: 5 * 1024 * 1024,
		headerTimeoutMs: 15_000,
		totalTimeoutMs: 30_000,
		maxRedirects: 3,
	});
	if (!fetched.success) {
		throw new Error(`publisher record proof fetch failed: ${fetched.error.code}`);
	}
	try {
		const verified = await verifyRecord({
			did: proof.did,
			collection: proof.collection,
			rkey: proof.rkey,
			publicKey: proof.publicKey,
			carBytes: fetched.value.bytes,
		});
		return { cid: verified.cid, record: verified.record };
	} catch (cause) {
		throw new Error("publisher record proof or signature is invalid", { cause });
	}
}

async function materializePublicKey(multibase: string): Promise<PublicKey> {
	const found = getPublicKeyFromDidController({ type: "Multikey", publicKeyMultibase: multibase });
	if (found.type === "p256") return P256PublicKey.importRaw(found.publicKeyBytes);
	if (found.type === "secp256k1") return Secp256k1PublicKey.importRaw(found.publicKeyBytes);
	const exhaustive: never = found;
	throw new Error(`unsupported AT Protocol signing key: ${JSON.stringify(exhaustive)}`);
}

function asAtprotoDid(value: string): AtprotoDid {
	if (!isAtprotoDid(value)) {
		throw new TypeError("publisher DID method is not supported by AT Protocol verification");
	}
	return value;
}

function isAtprotoDid(value: string): value is AtprotoDid {
	return isDid(value) && (value.startsWith("did:plc:") || value.startsWith("did:web:"));
}
