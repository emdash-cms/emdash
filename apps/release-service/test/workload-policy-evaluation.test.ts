import { describe, expect, it } from "vitest";

import type { StoredWorkloadPolicy } from "../src/publisher-do/workload-policy.js";
import {
	digestWorkloadIdempotencyIdentity,
	digestWorkloadIdentity,
	evaluateWorkloadPolicy,
	type WorkloadPolicyRejectionCode,
} from "../src/workload/policy.js";
import type { VerifiedWorkloadIdentity } from "../src/workload/types.js";

const identity: VerifiedWorkloadIdentity = {
	issuer: "github-actions",
	subject: "opaque-subject",
	tokenId: "token-id",
	repository: {
		name: "emdash-cms/gallery",
		id: "123456789",
		owner: "emdash-cms",
		ownerId: "987654321",
		visibility: "public",
	},
	workflow: {
		ref: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		sha: "a".repeat(40),
		jobRef: null,
		jobSha: null,
	},
	run: {
		id: "100",
		attempt: 2,
		actor: "release-bot",
		actorId: "200",
		eventName: "workflow_dispatch",
		ref: "refs/heads/main",
		refType: "branch",
		commitSha: "b".repeat(40),
		environment: "production",
		runnerEnvironment: "github-hosted",
	},
	issuedAt: 1_800_000_000,
	expiresAt: 1_800_000_300,
};

const policy: StoredWorkloadPolicy = {
	packageSlug: "gallery",
	repository: "emdash-cms/gallery",
	repositoryId: "123456789",
	repositoryOwnerId: "987654321",
	workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
	allowedRefs: ["refs/heads/main"],
	allowedEnvironments: ["production"],
	active: true,
	stateVersion: 1,
	authorizedBy: "did:plc:publisher",
	createdAt: 1_800_000_000_000,
	updatedAt: 1_800_000_000_000,
};

interface Replacement {
	identity?: {
		repository?: Partial<VerifiedWorkloadIdentity["repository"]>;
		workflow?: Partial<VerifiedWorkloadIdentity["workflow"]>;
		run?: Partial<VerifiedWorkloadIdentity["run"]>;
	};
	policy?: Partial<StoredWorkloadPolicy>;
}

const rejectionCases: ReadonlyArray<readonly [WorkloadPolicyRejectionCode, Replacement]> = [
	["WORKLOAD_POLICY_INACTIVE", { policy: { active: false } }],
	["WORKLOAD_REPOSITORY_MISMATCH", { identity: { repository: { name: "other/gallery" } } }],
	["WORKLOAD_REPOSITORY_MISMATCH", { identity: { repository: { id: "999" } } }],
	["WORKLOAD_REPOSITORY_MISMATCH", { identity: { repository: { ownerId: "999" } } }],
	["WORKLOAD_WORKFLOW_MISMATCH", { identity: { workflow: { ref: "other" } } }],
	["WORKLOAD_REF_MISMATCH", { identity: { run: { ref: "refs/heads/dev" } } }],
	["WORKLOAD_ENVIRONMENT_MISMATCH", { identity: { run: { environment: "staging" } } }],
];

describe("workload policy evaluation", () => {
	it("accepts the exact immutable repository, workflow, ref, and environment", () => {
		expect(evaluateWorkloadPolicy(identity, policy)).toEqual({ ok: true });
	});

	it("matches the repository portion of a workflow reference case-insensitively", () => {
		expect(
			evaluateWorkloadPolicy(
				{
					...identity,
					workflow: {
						...identity.workflow,
						ref: "EmDash-CMS/Gallery/.github/workflows/release.yml@refs/heads/main",
					},
				},
				policy,
			),
		).toEqual({ ok: true });
	});

	it.each(rejectionCases)("rejects %s", (code, replacement) => {
		const changedIdentity = {
			...identity,
			repository: {
				...identity.repository,
				...replacement.identity?.repository,
			},
			workflow: {
				...identity.workflow,
				...replacement.identity?.workflow,
			},
			run: {
				...identity.run,
				...replacement.identity?.run,
			},
		};
		expect(evaluateWorkloadPolicy(changedIdentity, { ...policy, ...replacement.policy })).toEqual({
			ok: false,
			code,
		});
	});

	it("treats empty ref and environment restrictions as wildcards", () => {
		expect(
			evaluateWorkloadPolicy(
				{ ...identity, run: { ...identity.run, ref: "refs/tags/v1", environment: null } },
				{ ...policy, allowedRefs: [], allowedEnvironments: [] },
			),
		).toEqual({ ok: true });
	});

	it("allows future version tags through bounded trailing-wildcard rules", () => {
		expect(
			evaluateWorkloadPolicy(
				{
					...identity,
					workflow: {
						...identity.workflow,
						ref: "emdash-cms/gallery/.github/workflows/release.yml@refs/tags/v2.0.0",
					},
					run: { ...identity.run, ref: "refs/tags/v2.0.0", refType: "tag" },
				},
				{
					...policy,
					workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/tags/*",
					allowedRefs: ["refs/tags/*"],
				},
			),
		).toEqual({ ok: true });
		expect(
			evaluateWorkloadPolicy(identity, {
				...policy,
				workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/tags/*",
				allowedRefs: ["refs/tags/*"],
			}),
		).toEqual({ ok: false, code: "WORKLOAD_WORKFLOW_MISMATCH" });
	});

	it("produces stable, domain-separated workload digests", async () => {
		const identityDigest = await digestWorkloadIdentity(identity);
		const idempotencyDigest = await digestWorkloadIdempotencyIdentity(
			identity,
			"did:plc:publisher",
			"gallery",
			"1.2.3",
		);

		expect(identityDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(idempotencyDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(identityDigest).not.toBe(idempotencyDigest);
		expect(await digestWorkloadIdentity({ ...identity })).toBe(identityDigest);
		expect(
			await digestWorkloadIdempotencyIdentity(
				{ ...identity, run: { ...identity.run, attempt: 3 } },
				"did:plc:publisher",
				"gallery",
				"1.2.3",
			),
		).toBe(idempotencyDigest);
		expect(
			await digestWorkloadIdempotencyIdentity(
				{ ...identity, run: { ...identity.run, id: "101" } },
				"did:plc:publisher",
				"gallery",
				"1.2.3",
			),
		).not.toBe(idempotencyDigest);
	});
});
