/**
 * Writes test/fixtures/publication-proofs.json: a fresh signing key and two
 * signed `com.atproto.sync.getRecord` CARs for the release record at the
 * deterministic key, one matching the workflow test's intent and one with a
 * different version. The release values come from
 * test/fixtures/publication-release.json, which the workflow test also reads.
 *
 * Run with `pnpm --filter @emdash-cms/release-service fixtures:proofs`.
 */

import { readFile, writeFile } from "node:fs/promises";

import { P256Keypair } from "@atproto/crypto";
import { parseCid } from "@atproto/lex-data";
import { MemoryBlockstore, Repo, WriteOpAction, getRecords } from "@atproto/repo";
import { NSID } from "@emdash-cms/registry-lexicons";

const RELEASE = JSON.parse(
	await readFile(new URL("../test/fixtures/publication-release.json", import.meta.url), "utf8"),
);
const COLLECTION = NSID.packageRelease;
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
					ref: parseCid(RELEASE.artifactBlobCid),
					mimeType: "application/gzip",
					size: 5,
				},
				checksum: RELEASE.artifactChecksum,
				contentType: "application/gzip",
			},
		},
		extensions: {
			[NSID.packageReleaseExtension]: {
				$type: NSID.packageReleaseExtension,
				provenance: RELEASE.provenance,
				declaredAccess: {},
			},
		},
	};
}

async function signedProof(keypair, record) {
	const storage = new MemoryBlockstore();
	const repo = await Repo.create(storage, RELEASE.publisherDid, keypair);
	const updated = await repo.applyWrites(
		{ action: WriteOpAction.Create, collection: COLLECTION, rkey: RELEASE.rkey, record },
		keypair,
	);
	const recordCid = await updated.data.get(`${COLLECTION}/${RELEASE.rkey}`);
	const chunks = [];
	for await (const chunk of getRecords(storage, updated.cid, [
		{ collection: COLLECTION, rkey: RELEASE.rkey },
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
