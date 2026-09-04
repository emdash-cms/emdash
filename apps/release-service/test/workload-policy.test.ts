import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { PutWorkloadPolicyInput } from "../src/publisher-do/publisher-do.js";

const DID = "did:plc:publisher";
const OTHER_DID = "did:plc:other";

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

function input(overrides: Partial<PutWorkloadPolicyInput> = {}): PutWorkloadPolicyInput {
	return {
		publisherDid: DID,
		packageSlug: "Gallery",
		repository: "EmDash-CMS/Gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "EmDash-CMS/Gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/tags/v2", "refs/heads/main"],
		allowedEnvironments: ["staging", "production"],
		active: true,
		expectedVersion: null,
		now: 1_800_000_000_000,
		...overrides,
	};
}

afterEach(async () => {
	await reset();
});

describe("publisher workload policies", () => {
	it("stores canonical immutable repository identity and sorted restrictions", async () => {
		const stub = publisher();
		const result = await stub.putWorkloadPolicy(input());

		expect(result).toEqual({
			ok: true,
			policy: {
				packageSlug: "Gallery",
				repository: "emdash-cms/gallery",
				repositoryId: "123456789",
				repositoryOwnerId: "987654321",
				workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
				allowedRefs: ["refs/heads/main", "refs/tags/v2"],
				allowedEnvironments: ["production", "staging"],
				active: true,
				stateVersion: 1,
				authorizedBy: DID,
				createdAt: 1_800_000_000_000,
				updatedAt: 1_800_000_000_000,
			},
		});
		if (!result.ok) return;
		await expect(stub.getWorkloadPolicy(DID, "Gallery")).resolves.toEqual(result.policy);
	});

	it("stores bounded version-tag patterns without accepting arbitrary globs", async () => {
		await expect(
			publisher().putWorkloadPolicy(
				input({
					workflowRef: "EmDash-CMS/Gallery/.github/workflows/release.yml@refs/tags/*",
					allowedRefs: ["refs/tags/*"],
				}),
			),
		).resolves.toMatchObject({
			ok: true,
			policy: {
				workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/tags/*",
				allowedRefs: ["refs/tags/*"],
			},
		});
		await runInDurableObject(publisher(), async (instance) => {
			await expect(
				instance.putWorkloadPolicy(
					input({
						workflowRef: "EmDash-CMS/Gallery/.github/workflows/*.yml@refs/tags/*",
					}),
				),
			).rejects.toEqual(expect.objectContaining({ code: "WORKLOAD_POLICY_INVALID" }));
		});
	});

	it("requires compare-and-set for replacement and preserves creation time", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(input());

		await expect(
			stub.putWorkloadPolicy(input({ expectedVersion: null, now: 1_800_000_000_001 })),
		).resolves.toEqual({ ok: false, code: "WORKLOAD_POLICY_CAS_REQUIRED" });
		const updated = await stub.putWorkloadPolicy(
			input({
				expectedVersion: 1,
				active: false,
				allowedRefs: ["refs/heads/main"],
				now: 1_800_000_000_002,
			}),
		);
		expect(updated).toMatchObject({
			ok: true,
			policy: {
				active: false,
				stateVersion: 2,
				createdAt: 1_800_000_000_000,
				updatedAt: 1_800_000_000_002,
			},
		});
	});

	it("lists policies with stable package-slug pagination", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(input({ packageSlug: "Alpha" }));
		await stub.putWorkloadPolicy(
			input({ packageSlug: "Beta", expectedVersion: null, now: 1_800_000_000_001 }),
		);

		await expect(stub.listWorkloadPolicies(DID, null, 1)).resolves.toMatchObject([
			{ packageSlug: "Alpha" },
		]);
		await expect(stub.listWorkloadPolicies(DID, "Alpha", 10)).resolves.toMatchObject([
			{ packageSlug: "Beta" },
		]);
	});

	it("appends publisher-attributed audit without storing token-shaped data", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(input());

		const audit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{
					event_type: string;
					actor_realm: string;
					actor_identity: string;
					subject: string;
					public_payload: string;
				}>(
					"SELECT event_type, actor_realm, actor_identity, subject, public_payload FROM audit_events",
				)
				.toArray(),
		);
		expect(audit).toEqual([
			{
				event_type: "workload-policy-stored",
				actor_realm: "publisher",
				actor_identity: DID,
				subject: "Gallery",
				public_payload: "{}",
			},
		]);
	});

	it("rejects invalid workflow ownership, duplicate restrictions, and publisher mismatch", async () => {
		const stub = publisher();
		await runInDurableObject(stub, async (instance) => {
			await expect(
				instance.putWorkloadPolicy({
					...input(),
					// @ts-expect-error - exercises an untyped RPC payload
					repository: 42,
				}),
			).rejects.toEqual(expect.objectContaining({ code: "WORKLOAD_POLICY_INVALID" }));
			await expect(
				instance.putWorkloadPolicy(
					input({
						workflowRef: "attacker/repo/.github/workflows/release.yml@refs/heads/main",
					}),
				),
			).rejects.toEqual(expect.objectContaining({ code: "WORKLOAD_POLICY_INVALID" }));
			await expect(
				instance.putWorkloadPolicy(input({ allowedRefs: ["refs/heads/main", "refs/heads/main"] })),
			).rejects.toEqual(expect.objectContaining({ code: "WORKLOAD_POLICY_INVALID" }));
			await expect(instance.putWorkloadPolicy(input({ publisherDid: OTHER_DID }))).rejects.toEqual(
				expect.objectContaining({ code: "PUBLISHER_DID_MISMATCH" }),
			);
		});
	});
});
