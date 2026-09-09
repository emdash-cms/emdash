import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { OperatorIdentity } from "../src/access.js";
import {
	handleOperatorApi,
	readOperatorRelatedProfile,
	type OperatorApiDependencies,
} from "../src/operator/api.js";
import { seedAssessment } from "./issuer-helpers.js";

const ADMIN: OperatorIdentity = {
	kind: "human",
	email: "admin@example.com",
	sub: "admin-subject",
	roles: ["admin"],
};

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("operator administration reads", () => {
	it("uses the latest prepared assessment for the current related profile", async () => {
		const profileUri =
			"at://did:example:publisher/com.emdashcms.experimental.package.profile/example";
		await seedAssessment(env.DB, { id: "related-profile-old", state: "review", uri: profileUri });
		await seedAssessment(env.DB, {
			id: "related-profile-current",
			state: "review",
			uri: profileUri,
		});
		await env.DB.prepare(
			"UPDATE assessments SET canonical_input_json = ? WHERE run_key = 'related-profile-current'",
		)
			.bind(
				JSON.stringify({ input: { name: "Current profile", authors: [{ name: "Publisher" }] } }),
			)
			.run();
		await env.DB.prepare(
			"UPDATE current_assessments SET assessment_id = 'related-profile-old' WHERE subject_uri = ?",
		)
			.bind(profileUri)
			.run();

		await expect(
			readOperatorRelatedProfile(env.DB, {
				input: { publisherDid: "did:example:publisher", packageSlug: "example" },
			}),
		).resolves.toEqual({ name: "Current profile", authors: [{ name: "Publisher" }] });
	});

	it("serves only quarantined media referenced by an assessment", async () => {
		const runKey = "operator-media-preview";
		const sha256 = "a".repeat(64);
		const objectKey = `media/${sha256}/12345678-1234-4123-8123-123456789abc`;
		const bytes = new TextEncoder().encode("verified-image-bytes");
		await seedAssessment(env.DB, { id: runKey, state: "review" });
		await env.DB.prepare("UPDATE assessments SET canonical_input_json = ? WHERE run_key = ?")
			.bind(
				JSON.stringify({
					mediaEvidence: [
						{
							kind: "icon",
							index: 0,
							sha256,
							mimeType: "image/png",
							contentRef: `r2://quarantine/${objectKey}`,
						},
					],
				}),
				runKey,
			)
			.run();
		await env.MEDIA_QUARANTINE.put(objectKey, bytes);

		const response = await handleOperatorApi(
			new Request(`https://labels.example/_admin/api/assessments/${runKey}/media/icon/0`),
			env,
			dependencies(),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

		const missing = await handleOperatorApi(
			new Request(`https://labels.example/_admin/api/assessments/${runKey}/media/icon/1`),
			env,
			dependencies(),
		);
		expect(missing.status).toBe(404);
	});

	it("reads the persisted issuance control state", async () => {
		await env.DB.prepare(
			`INSERT INTO service_state (key, value, updated_at)
			 VALUES ('issuance_paused', '1', '2026-08-27T10:00:00.000Z')
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).run();

		const response = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/issuance"),
			env,
			dependencies(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			paused: true,
			updatedAt: "2026-08-27T10:00:00.000Z",
		});
	});

	it("lists durable evaluation runs newest first", async () => {
		await env.DB.prepare(
			`INSERT INTO eval_runs
			   (idempotency_key, actor_did, actor_role, reason, status,
			    failure_code, failure_summary, created_at, updated_at, completed_at)
			 VALUES (?, ?, 'admin', ?, 'failed', ?, ?, ?, ?, ?)`,
		)
			.bind(
				"admin-eval-read-001",
				"did:web:labels.example:operators:admin",
				"Verify a candidate release",
				"EVALUATION_FAILED",
				"Protected evaluation failed",
				"2026-08-27T10:00:00.000Z",
				"2026-08-27T10:01:00.000Z",
				"2026-08-27T10:01:00.000Z",
			)
			.run();

		const response = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/evals?limit=10"),
			env,
			dependencies(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [
				{
					reason: "Verify a candidate release",
					status: "failed",
					failure_code: "EVALUATION_FAILED",
				},
			],
		});
	});

	it("lists immutable operator activity without accepting malformed cursors", async () => {
		await env.DB.prepare(
			`INSERT INTO operator_actions
			   (actor_did, actor_role, action, subject_uri, subject_cid, reason,
			    idempotency_key, created_at)
			 VALUES (?, 'admin', 'takedown', ?, NULL, ?, ?, ?)`,
		)
			.bind(
				"did:web:labels.example:operators:admin",
				"did:plc:unsafe",
				"Confirmed policy violation",
				"admin-takedown-read-001",
				"2026-08-27T10:02:00.000Z",
			)
			.run();

		const response = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/activity?limit=10"),
			env,
			dependencies(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			items: [
				{
					action: "takedown",
					subject_uri: "did:plc:unsafe",
					reason: "Confirmed policy violation",
				},
			],
		});

		const invalid = await handleOperatorApi(
			new Request("https://labels.example/_admin/api/activity?cursor=not-a-number"),
			env,
			dependencies(),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
	});
});

function dependencies(): OperatorApiDependencies {
	return {
		authenticate: async () => ADMIN,
		actorDid: async () => "did:web:labels.example:operators:admin",
		getRun: async () => null,
		isCurrentSubject: async () => true,
		issuer: {
			approve: async () => ({ action: "approve", operatorActionId: 1, labels: [] }),
			block: async () => ({ action: "block", operatorActionId: 1, labels: [] }),
			issue: async () => {
				throw new Error("not used");
			},
		},
		rerun: async () => "not-used",
		now: () => new Date("2026-08-27T10:00:00.000Z"),
	};
}
