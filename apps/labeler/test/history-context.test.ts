import { createLabelSigner, type LabelSigner } from "@emdash-cms/registry-moderation";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createAssessmentRun, createSubject, type Assessment } from "../src/assessment-store.js";
import {
	allowedFindingCategories,
	HISTORY_FINDING_CATEGORIES,
	validateFindings,
} from "../src/findings.js";
import { analyzeHistory } from "../src/history-context.js";
import { MODERATION_POLICY } from "../src/policy.js";
import { issueManualLabel } from "../src/service.js";
import { initializeSigningState } from "../src/signing-rotation.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
const LABELER_DID = "did:web:labels.emdashcms.com";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const config = { labelerDid: LABELER_DID, signingKeyVersion: "v1" };

let counter = 0;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
	await initializeSigningState(testEnv.DB, {
		issuerDid: LABELER_DID,
		keyVersion: "v1",
		publicKeyMultibase: MULTIKEY,
	});
});

function signer(): Promise<LabelSigner> {
	return createLabelSigner({
		issuerDid: LABELER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => ({
			id: LABELER_DID,
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: LABELER_DID,
					publicKeyMultibase: MULTIKEY,
				},
			],
		}),
	});
}

function uriFor(did: string, name: string): string {
	return `at://${did}/com.emdashcms.experimental.package.release/${name}:1.0.0`;
}

async function seedSubject(did: string, name: string): Promise<{ uri: string; cid: string }> {
	const uri = uriFor(did, name);
	const cid = `bafkreicid${counter++}00000000000000000000000000000000000000`;
	await createSubject(testEnv.DB, {
		uri,
		cid,
		did,
		collection: "com.emdashcms.experimental.package.release",
		rkey: `${name}:1.0.0`,
	});
	return { uri, cid };
}

async function seedAssessmentWithChecksum(
	subject: { uri: string; cid: string },
	checksum: string,
): Promise<void> {
	await createAssessmentRun(testEnv.DB, {
		runKey: `rk-${counter++}`,
		uri: subject.uri,
		cid: subject.cid,
		artifactChecksum: checksum,
		trigger: "initial",
		triggerId: `trigger-${counter++}`,
		policyVersion: MODERATION_POLICY.policyVersion,
		coverageJson: "{}",
	});
}

function assessmentFor(input: {
	uri: string;
	cid: string;
	artifactChecksum?: string | null;
}): Assessment {
	return {
		id: "asmt_under_test",
		runKey: "rk_under_test",
		uri: input.uri,
		cid: input.cid,
		artifactId: null,
		artifactChecksum: input.artifactChecksum ?? null,
		state: "running",
		trigger: "initial",
		triggerId: "trigger",
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: null,
		promptHash: null,
		publicSummary: null,
		coverageJson: "{}",
		supersedesAssessmentId: null,
		startedAt: null,
		completedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("analyzeHistory", () => {
	it("returns no findings for a fresh publisher with no reuse and no manual labels", async () => {
		const did = "did:plc:fresh0000000000000000000000";
		const subject = await seedSubject(did, "only");
		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: subject.uri, cid: subject.cid }),
			{ src: LABELER_DID },
		);
		expect(findings).toEqual([]);
	});

	it("reports prior releases from the same publishing DID", async () => {
		const did = "did:plc:prior000000000000000000000";
		const current = await seedSubject(did, "current");
		await seedSubject(did, "older-a");
		await seedSubject(did, "older-b");

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: current.uri, cid: current.cid }),
			{ src: LABELER_DID },
		);

		expect(findings).toHaveLength(1);
		const finding = findings[0]!;
		expect(finding.source).toBe("history");
		expect(finding.category).toBe("publisher-history");
		expect(finding.title).toContain("2 prior releases");
	});

	it("caps the prior-release count and reports it as bounded", async () => {
		const did = "did:plc:manyreleases00000000000000";
		const current = await seedSubject(did, "many-current");
		for (let i = 0; i < 4; i++) await seedSubject(did, `many-${i}`);

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: current.uri, cid: current.cid }),
			{ src: LABELER_DID, priorReleaseLimit: 2 },
		);

		expect(findings[0]!.title).toContain("at least 2 prior releases");
	});

	it("reports the same artifact checksum submitted under a different publisher (global, cross-DID)", async () => {
		const checksum = `sha256-shared-${counter++}`;
		const subjectA = await seedSubject("did:plc:pubA00000000000000000000000", "reuse-a");
		const subjectB = await seedSubject("did:plc:pubB00000000000000000000000", "reuse-b");
		await seedAssessmentWithChecksum(subjectB, checksum);

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: subjectA.uri, cid: subjectA.cid, artifactChecksum: checksum }),
			{ src: LABELER_DID },
		);

		const shared = findings.find((f) => f.category === "shared-artifact");
		expect(shared).toBeDefined();
		expect(shared!.source).toBe("history");
		// Cross-publisher correlation is a deanonymization signal: it must stay out
		// of the public-facing title and summary, only in privateDetail.
		expect(shared!.title).not.toContain("did:plc:pubB00000000000000000000000");
		expect(shared!.publicSummary).not.toContain("did:plc:pubB00000000000000000000000");
		expect(shared!.publicSummary).not.toContain("1 other");
		expect(shared!.privateDetail).toContain("1 other publisher");
		expect(shared!.privateDetail).toContain("did:plc:pubB00000000000000000000000");
	});

	it("does not flag the same checksum submitted only under the subject's own DID", async () => {
		const did = "did:plc:selfreuse0000000000000000";
		const checksum = `sha256-self-${counter++}`;
		const first = await seedSubject(did, "self-a");
		const second = await seedSubject(did, "self-b");
		await seedAssessmentWithChecksum(first, checksum);

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: second.uri, cid: second.cid, artifactChecksum: checksum }),
			{ src: LABELER_DID },
		);

		expect(findings.find((f) => f.category === "shared-artifact")).toBeUndefined();
	});

	it("reports active manual labels on the subject", async () => {
		const did = "did:plc:manuallabel00000000000000";
		const subject = await seedSubject(did, "manual");
		await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			{
				actor: LABELER_DID,
				type: "manual-label",
				reason: "reviewer: confirmed security issue",
				idempotencyKey: `manual-${counter++}`,
			},
			{ uri: subject.uri, val: "security-yanked" },
		);

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: subject.uri, cid: subject.cid }),
			{ src: LABELER_DID },
		);

		const manual = findings.find((f) => f.category === "active-manual-label");
		expect(manual).toBeDefined();
		expect(manual!.source).toBe("history");
		// The existence and identity of manual labels (including redactions) must
		// not leak into the public-facing fields.
		expect(manual!.title).not.toContain("security-yanked");
		expect(manual!.publicSummary).not.toContain("security-yanked");
		expect(manual!.privateDetail).toContain("security-yanked");
	});

	it("emits all three context findings together, each valid under the amended finding contract", async () => {
		const did = "did:plc:allthree00000000000000000";
		const other = "did:plc:othercombined0000000000000";
		const checksum = `sha256-all-${counter++}`;
		const current = await seedSubject(did, "all-current");
		await seedSubject(did, "all-older");
		const otherSubject = await seedSubject(other, "all-other");
		await seedAssessmentWithChecksum(otherSubject, checksum);
		await issueManualLabel(
			testEnv.DB,
			config,
			await signer(),
			{
				actor: LABELER_DID,
				type: "manual-label",
				reason: "reviewer: disputed",
				idempotencyKey: `manual-all-${counter++}`,
			},
			{ uri: current.uri, val: "security-yanked" },
		);

		const findings = await analyzeHistory(
			testEnv.DB,
			assessmentFor({ uri: current.uri, cid: current.cid, artifactChecksum: checksum }),
			{ src: LABELER_DID },
		);

		expect(findings.map((f) => f.category).toSorted()).toEqual([
			"active-manual-label",
			"publisher-history",
			"shared-artifact",
		]);
		for (const finding of findings)
			expect(HISTORY_FINDING_CATEGORIES.has(finding.category)).toBe(true);

		// The orchestrator validates every stage's output with the block∪warn
		// allowed set; the amended validator must still admit these history findings.
		const validated = validateFindings(findings, {
			allowedCategories: allowedFindingCategories(MODERATION_POLICY),
			resolvableEvidenceIds: new Set(),
		});
		expect(validated).toHaveLength(3);
	});

	it("is best-effort: a D1 failure yields no findings rather than failing the run", async () => {
		const brokenDb = {
			prepare() {
				throw new Error("D1 unavailable");
			},
		} as unknown as D1Database;

		await expect(
			analyzeHistory(brokenDb, assessmentFor({ uri: "at://x/y/z", cid: "cid" }), {
				src: LABELER_DID,
			}),
		).resolves.toEqual([]);
	});
});
