/**
 * Writes test/fixtures/publication-proofs.json: a fresh signing key and two
 * signed `com.atproto.sync.getRecord` CARs for the release record at the
 * deterministic key, one matching the workflow test's intent and one with a
 * different version.
 *
 * Run with `pnpm --filter @emdash-cms/release-service fixtures:proofs`.
 */

import { writeFile } from "node:fs/promises";

import { P256Keypair } from "@atproto/crypto";
import { parseCid } from "@atproto/lex-data";
import { MemoryBlockstore, Repo, WriteOpAction, getRecords } from "@atproto/repo";

const PUBLISHER_DID = "did:web:publisher.example.com";
const COLLECTION = "com.emdashcms.experimental.package.release";
const RKEY = "gallery:1.2.3";
const ARTIFACT_CHECKSUM = "bciqhazpl5w2ra742ngjezwxoy4p74p2eyiftnnhycsofanwmdrezity";
const ARTIFACT_BLOB_CID = "bafkreidqmxv63niqp6ngtesm3lxmoh76h5cmeczwwt4bjhcqg3gbysmuj4";
const FIXTURE_PATH = new URL("../test/fixtures/publication-proofs.json", import.meta.url);

function releaseRecord(version) {
	return {
		$type: COLLECTION,
		package: "gallery",
		version,
		artifacts: {
			package: {
				blob: {
					$type: "blob",
					// A `{ $link }` map would be encoded as a plain map, not as a CID link.
					ref: parseCid(ARTIFACT_BLOB_CID),
					mimeType: "application/gzip",
					size: 5,
				},
				checksum: ARTIFACT_CHECKSUM,
				contentType: "application/gzip",
			},
		},
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				provenance: {
					url: "https://github.com/example/gallery/attestation.sigstore.json",
					checksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					builderId:
						"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://github.com/example/gallery",
				},
				declaredAccess: {},
			},
		},
	};
}

async function signedProof(keypair, record) {
	const storage = new MemoryBlockstore();
	const repo = await Repo.create(storage, PUBLISHER_DID, keypair);
	const updated = await repo.applyWrites(
		{ action: WriteOpAction.Create, collection: COLLECTION, rkey: RKEY, record },
		keypair,
	);
	const recordCid = await updated.data.get(`${COLLECTION}/${RKEY}`);
	const chunks = [];
	for await (const chunk of getRecords(storage, updated.cid, [
		{ collection: COLLECTION, rkey: RKEY },
	])) {
		chunks.push(chunk);
	}
	return { proof: Buffer.concat(chunks).toString("base64"), recordCid: recordCid.toString() };
}

const keypair = await P256Keypair.create();
const exact = await signedProof(keypair, releaseRecord("1.2.3"));
const conflict = await signedProof(keypair, releaseRecord("9.9.9"));

const fixture = {
	signingKey: keypair.did().replace("did:key:", ""),
	exactRecordCid: exact.recordCid,
	exactProof: exact.proof,
	conflictProof: conflict.proof,
};
await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, "\t")}\n`);
console.log(`Wrote ${FIXTURE_PATH.pathname} (exact record ${exact.recordCid})`);
