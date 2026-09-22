import type { DidDocument } from "@atcute/identity";
import { describe, expect, it, vi } from "vitest";

import { createAtprotoExactRecordVerifier } from "../src/assessment/records.js";
import { PROFILE_CID, PROFILE_RECORD, PROFILE_URI, PUBLISHER_DID } from "./assessment-fixtures.js";

const PUBLIC_MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";

describe("production AT Protocol record verifier", () => {
	it("resolves the publisher authority and verifies the exact URI and CID proof", async () => {
		const resolveDid = vi.fn(
			async (): Promise<DidDocument> => ({
				id: PUBLISHER_DID,
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: PUBLIC_MULTIKEY,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example",
					},
				],
			}),
		);
		const fetchRecordProof = vi.fn(async () => ({ cid: PROFILE_CID, record: PROFILE_RECORD }));
		const verifier = createAtprotoExactRecordVerifier({ resolveDid, fetchRecordProof });

		await expect(
			verifier.verifyExactRecord({ uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" }),
		).resolves.toMatchObject({
			uri: PROFILE_URI,
			cid: PROFILE_CID,
			verification: "did-mst-signature",
		});
		expect(resolveDid).toHaveBeenCalledWith(PUBLISHER_DID);
		expect(fetchRecordProof).toHaveBeenCalledWith(
			expect.objectContaining({
				pds: "https://pds.example",
				did: PUBLISHER_DID,
				collection: "com.emdashcms.experimental.package.profile",
				rkey: "gallery",
			}),
		);
	});

	it("rejects when the verified proof is for a different CID", async () => {
		const verifier = createAtprotoExactRecordVerifier({
			resolveDid: async (): Promise<DidDocument> => ({
				id: PUBLISHER_DID,
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: PUBLIC_MULTIKEY,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example",
					},
				],
			}),
			fetchRecordProof: async () => ({
				cid: `${PROFILE_CID.slice(0, -1)}z`,
				record: PROFILE_RECORD,
			}),
		});
		await expect(
			verifier.verifyExactRecord({ uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" }),
		).rejects.toThrow(/exact CID/);
	});
});
