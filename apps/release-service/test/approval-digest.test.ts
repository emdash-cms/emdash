import { describe, expect, it } from "vitest";

import {
	ApprovalDigestError,
	computeApprovalDecisionDigest,
	computeApprovalEvidenceDigest,
	decodeAwaitingApprovalState,
	encodeAwaitingApprovalState,
	type ApprovalEvidence,
} from "../src/approvals/digest.js";

const DIGEST_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST_C = "ccccccccccccccccccccccccccccccccccccccccccc";
const DIGEST_D = "ddddddddddddddddddddddddddddddddddddddddddd";

const EVIDENCE: ApprovalEvidence = {
	intentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	publisherDid: "did:plc:publisher",
	packageSlug: "example-plugin",
	version: "1.2.3",
	verificationGeneration: 4,
	workloadIdentityDigest: DIGEST_A,
	releaseInputDigest: DIGEST_B,
	profileCid: "bafyreib3p6qexampleprofilecid",
	baselineReleaseCid: "bafyreib3p6qexamplebaselinecid",
	artifactChecksum: "sha256:0123456789abcdef",
	provenanceChecksum: "sha256:fedcba9876543210",
	declaredAccessDiffDigest: DIGEST_C,
	verificationDigest: DIGEST_D,
};

describe("approval digest", () => {
	it("is deterministic and domain-separates evidence from a decision", async () => {
		const first = await computeApprovalEvidenceDigest(EVIDENCE);
		const second = await computeApprovalEvidenceDigest({ ...EVIDENCE });
		const decision = await computeApprovalDecisionDigest({
			evidenceDigest: first,
			approverDid: "did:plc:approver",
			decision: "approve",
		});

		expect(first).toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(decision).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(decision).not.toBe(first);
	});

	it.each([
		["intent", { ...EVIDENCE, intentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }],
		["publisher", { ...EVIDENCE, publisherDid: "did:plc:other" }],
		["package", { ...EVIDENCE, packageSlug: "other-plugin" }],
		["version", { ...EVIDENCE, version: "1.2.4" }],
		["generation", { ...EVIDENCE, verificationGeneration: 5 }],
		["workload", { ...EVIDENCE, workloadIdentityDigest: DIGEST_B }],
		["release input", { ...EVIDENCE, releaseInputDigest: DIGEST_C }],
		["profile", { ...EVIDENCE, profileCid: "bafyreib3p6qotherprofilecid" }],
		["baseline", { ...EVIDENCE, baselineReleaseCid: null }],
		["artifact", { ...EVIDENCE, artifactChecksum: "sha256:1111111111111111" }],
		["provenance", { ...EVIDENCE, provenanceChecksum: "sha256:2222222222222222" }],
		["access diff", { ...EVIDENCE, declaredAccessDiffDigest: DIGEST_D }],
		["verification", { ...EVIDENCE, verificationDigest: DIGEST_A }],
	] satisfies Array<[string, ApprovalEvidence]>)(
		"changes when the %s binding changes",
		async (_name, changed) => {
			await expect(computeApprovalEvidenceDigest(changed)).resolves.not.toBe(
				await computeApprovalEvidenceDigest(EVIDENCE),
			);
		},
	);

	it("binds the approver DID and approve/reject decision", async () => {
		const evidenceDigest = await computeApprovalEvidenceDigest(EVIDENCE);
		const approve = await computeApprovalDecisionDigest({
			evidenceDigest,
			approverDid: "did:plc:approver",
			decision: "approve",
		});
		const reject = await computeApprovalDecisionDigest({
			evidenceDigest,
			approverDid: "did:plc:approver",
			decision: "reject",
		});
		const otherApprover = await computeApprovalDecisionDigest({
			evidenceDigest,
			approverDid: "did:plc:other",
			decision: "approve",
		});

		expect(approve).not.toBe(reject);
		expect(approve).not.toBe(otherApprover);
	});

	it("round-trips only its canonical awaiting-approval state", async () => {
		const encoded = await encodeAwaitingApprovalState(EVIDENCE, ["did:plc:approver"]);
		await expect(decodeAwaitingApprovalState(encoded)).resolves.toEqual({
			approvalEvidence: EVIDENCE,
			approvalEvidenceDigest: await computeApprovalEvidenceDigest(EVIDENCE),
			approverDids: ["did:plc:approver"],
		});

		const reordered = JSON.stringify({
			approvalEvidenceDigest: await computeApprovalEvidenceDigest(EVIDENCE),
			approvalEvidence: EVIDENCE,
			approverDids: ["did:plc:approver"],
		});
		await expect(decodeAwaitingApprovalState(reordered)).rejects.toBeInstanceOf(
			ApprovalDigestError,
		);
	});

	it("uses ordinal ordering for canonical approver DIDs", async () => {
		const encoded = await encodeAwaitingApprovalState(EVIDENCE, ["did:plc:a", "did:plc:B"]);
		const parsed = JSON.parse(encoded) as { approverDids: string[] };

		expect(parsed.approverDids).toEqual(["did:plc:B", "did:plc:a"]);
	});

	it("rejects a substituted evidence digest", async () => {
		const encoded = await encodeAwaitingApprovalState(EVIDENCE, ["did:plc:approver"]);
		const substituted = encoded.replace(await computeApprovalEvidenceDigest(EVIDENCE), DIGEST_A);

		await expect(decodeAwaitingApprovalState(substituted)).rejects.toBeInstanceOf(
			ApprovalDigestError,
		);
	});

	it("rejects malformed evidence and decision inputs", async () => {
		await expect(
			computeApprovalEvidenceDigest({ ...EVIDENCE, profileCid: "bad cid" }),
		).rejects.toBeInstanceOf(ApprovalDigestError);
		await expect(
			computeApprovalDecisionDigest({
				evidenceDigest: "short",
				approverDid: "did:plc:approver",
				decision: "approve",
			}),
		).rejects.toBeInstanceOf(ApprovalDigestError);
	});
});
