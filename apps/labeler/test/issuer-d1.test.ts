import { reduceListingLabels, verifyListingLabel } from "@emdash-cms/registry-moderation";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ListingLabelProposal } from "../src/labels/types.js";
import {
	ADMIN_DID,
	createTestIssuer,
	decisionContext,
	ISSUER_DID,
	labelDidDocument,
	PROFILE_URI,
	profileProposal,
	PROFILE_SUBJECT,
	reviewerContext,
	seedAssessment,
	SUBJECT_CID,
} from "./issuer-helpers.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("D1 listing label issuer", () => {
	it("allocates unique monotonic sequences under concurrent issuance", async () => {
		const issuer = await createTestIssuer(env.DB);
		const decisions = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				issuer.block(
					decisionContext(`concurrent-${index}`),
					PROFILE_SUBJECT,
					new Date(`2026-08-24T12:00:${`${index}`.padStart(2, "0")}.000Z`),
				),
			),
		);
		const issued = decisions.flatMap((decision) => decision.labels);
		const sequences = issued
			.map((result) => result.sequence)
			.toSorted((left, right) => left - right);
		expect(sequences).toEqual(Array.from({ length: 24 }, (_, index) => index + 1));
		expect(new Set(sequences)).toHaveLength(24);

		for (const result of issued) {
			await expect(
				verifyListingLabel({
					label: result.label,
					resolveDid: async () => labelDidDocument(),
				}),
			).resolves.toEqual(expect.objectContaining({ src: ISSUER_DID, cid: SUBJECT_CID }));
		}
	});

	it("returns the stored result for an identical idempotent retry", async () => {
		const issuer = await createTestIssuer(env.DB);
		const context = decisionContext("idempotent");
		const first = await issuer.approve(
			context,
			PROFILE_SUBJECT,
			new Date("2026-08-24T12:00:00.000Z"),
		);
		const retried = await issuer.approve(
			context,
			PROFILE_SUBJECT,
			new Date("2026-08-24T13:00:00.000Z"),
		);
		expect(retried).toEqual(first);
		const count = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM issued_labels WHERE operator_action_id = ?",
		)
			.bind(first.operatorActionId)
			.first<{ count: number }>();
		expect(count?.count).toBe(first.labels.length);
	});

	it("binds idempotency to actor, reason, action, subject, and proposal", async () => {
		const issuer = await createTestIssuer(env.DB);
		const context = decisionContext("bound");
		await issuer.approve(context, PROFILE_SUBJECT);

		await expect(
			issuer.approve({ ...context, reason: "A different reason" }, PROFILE_SUBJECT),
		).rejects.toThrow("different decision");
		await expect(issuer.block(context, PROFILE_SUBJECT)).rejects.toThrow("different decision");
	});

	it("links a multi-label decision to one immutable operator action", async () => {
		const issuer = await createTestIssuer(env.DB);
		const context = decisionContext("approval");
		const decision = await issuer.approve(context, PROFILE_SUBJECT);
		expect(decision.labels).toHaveLength(2);
		expect(new Set(decision.labels.map((label) => label.operatorActionId))).toEqual(
			new Set([decision.operatorActionId]),
		);

		const actionCount = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM operator_actions WHERE idempotency_key = ?",
		)
			.bind(context.idempotencyKey)
			.first<{ count: number }>();
		expect(actionCount?.count).toBe(1);
		await expect(
			env.DB.prepare("UPDATE operator_actions SET reason = 'changed' WHERE id = ?")
				.bind(decision.operatorActionId)
				.run(),
		).rejects.toThrow("operator actions are immutable");
	});

	it("enforces role, action, exact-CID, and listing-only boundaries", async () => {
		const issuer = await createTestIssuer(env.DB);
		await expect(
			issuer.issue(
				{
					actorDid: ISSUER_DID,
					role: "automation",
					assessmentId: "assessment-1",
					policyVersion: "policy-v1",
					outcome: "passed",
					reason: "Automated result",
					idempotencyKey: "automated-block",
				},
				profileProposal("listing-blocked"),
			),
		).rejects.toThrow("automation cannot issue");
		await expect(
			issuer.issue(
				{
					...reviewerContext("reviewer-takedown"),
					operatorAction: {
						action: "takedown",
						idempotencyKey: "action-reviewer-takedown",
					},
				},
				{ subject: { uri: PROFILE_URI }, value: "!takedown" },
			),
		).rejects.toThrow("only admins");
		await expect(
			issuer.issue(
				{
					actorDid: ADMIN_DID,
					role: "admin",
					reason: "Emergency redaction",
					idempotencyKey: "admin-takedown",
					operatorAction: { action: "takedown", idempotencyKey: "action-admin-takedown" },
				},
				{ subject: { uri: PROFILE_URI }, value: "!takedown" },
			),
		).resolves.toEqual(expect.objectContaining({ actorRole: "admin" }));

		const mismatched: ListingLabelProposal = {
			subject: { kind: "release", uri: PROFILE_URI, cid: SUBJECT_CID },
			value: "listing-passed",
		};
		await expect(issuer.approve(decisionContext("wrong-kind"), mismatched.subject)).rejects.toThrow(
			"collection must match",
		);
	});

	it("allocates a strictly later timestamp for a same-millisecond takedown retraction", async () => {
		const issuer = await createTestIssuer(env.DB);
		const createdAt = new Date("2026-08-24T12:30:00.000Z");
		const takedown = await issuer.issue(
			{
				actorDid: ADMIN_DID,
				role: "admin",
				reason: "Emergency takedown",
				idempotencyKey: "same-time-takedown",
				operatorAction: { action: "takedown", idempotencyKey: "same-time-takedown" },
			},
			{ subject: { uri: PROFILE_URI }, value: "!takedown" },
			createdAt,
		);
		const retracted = await issuer.issue(
			{
				actorDid: ADMIN_DID,
				role: "admin",
				reason: "Takedown no longer required",
				idempotencyKey: "same-time-retract",
				operatorAction: { action: "retract-takedown", idempotencyKey: "same-time-retract" },
			},
			{ subject: { uri: PROFILE_URI }, value: "!takedown", negate: true },
			createdAt,
		);
		expect(Date.parse(retracted.label.cts)).toBeGreaterThan(Date.parse(takedown.label.cts));
		expect(
			reduceListingLabels([takedown.label, retracted.label], retracted.label.cts).states[0],
		).toMatchObject({ active: false, collision: [] });
	});

	it("prevents automation from negating an action-backed decision", async () => {
		const issuer = await createTestIssuer(env.DB);
		await issuer.approve(decisionContext("manual-pass-guard"), PROFILE_SUBJECT);
		await seedAssessment(env.DB, { id: "assessment-negation-guard", state: "passed" });
		await expect(
			issuer.issue(
				{
					actorDid: ISSUER_DID,
					role: "automation",
					assessmentId: "assessment-negation-guard",
					policyVersion: "policy-v1",
					outcome: "passed",
					reason: "Automated rerun",
					idempotencyKey: "automated-negation-guard",
				},
				{ ...profileProposal(), negate: true },
			),
		).rejects.toThrow("manual-decision state");
		await expect(
			issuer.issue(
				{
					actorDid: ISSUER_DID,
					role: "automation",
					assessmentId: "assessment-negation-guard",
					policyVersion: "policy-v1",
					outcome: "passed",
					reason: "Automated rerun",
					idempotencyKey: "automated-supersession-guard",
				},
				profileProposal(),
			),
		).rejects.toThrow("manual-decision state");
	});

	it("binds automation to the exact assessment subject, outcome, and policy", async () => {
		const issuer = await createTestIssuer(env.DB);
		const automatedUri = `${PROFILE_URI}-automation`;
		await seedAssessment(env.DB, {
			id: "assessment-authorized",
			state: "passed",
			uri: automatedUri,
		});
		const automatedProposal: ListingLabelProposal = {
			subject: { kind: "profile", uri: automatedUri, cid: SUBJECT_CID },
			value: "listing-passed",
		};
		const context = {
			actorDid: ISSUER_DID,
			role: "automation" as const,
			assessmentId: "assessment-authorized",
			policyVersion: "policy-v1",
			outcome: "passed" as const,
			reason: "Automated assessment",
			idempotencyKey: "automated-authorized",
		};
		await expect(issuer.issue(context, automatedProposal)).resolves.toEqual(
			expect.objectContaining({
				assessmentId: context.assessmentId,
				assessmentPolicyVersion: context.policyVersion,
				assessmentOutcome: context.outcome,
			}),
		);

		const otherSubject: ListingLabelProposal = {
			subject: {
				kind: "profile",
				uri: `${automatedUri}-other`,
				cid: SUBJECT_CID,
			},
			value: "listing-passed",
		};
		await expect(
			issuer.issue({ ...context, idempotencyKey: "automated-other" }, otherSubject),
		).rejects.toThrow("not authorized");

		await seedAssessment(env.DB, {
			id: "assessment-wrong-policy",
			state: "passed",
			uri: `${PROFILE_URI}-wrong-policy`,
			policyVersion: "policy-v2",
		});
		await expect(
			issuer.issue(
				{
					...context,
					assessmentId: "assessment-wrong-policy",
					idempotencyKey: "automated-wrong-policy",
				},
				{
					subject: {
						kind: "profile",
						uri: `${PROFILE_URI}-wrong-policy`,
						cid: SUBJECT_CID,
					},
					value: "listing-passed",
				},
			),
		).rejects.toThrow("not authorized");
	});

	it("rolls back the complete decision when one label idempotency key collides", async () => {
		const issuer = await createTestIssuer(env.DB);
		await issuer.issue(
			{
				actorDid: ADMIN_DID,
				role: "admin",
				reason: "Pre-existing collision",
				idempotencyKey: "decision-atomic:label:1",
				operatorAction: {
					action: "takedown",
					idempotencyKey: "pre-existing-collision-action",
				},
			},
			{ subject: { uri: PROFILE_URI }, value: "!takedown" },
		);

		await expect(issuer.approve(decisionContext("atomic"), PROFILE_SUBJECT)).rejects.toThrow(
			"UNIQUE constraint",
		);
		const action = await env.DB.prepare(
			"SELECT id FROM operator_actions WHERE idempotency_key = 'decision-atomic'",
		).first();
		const partial = await env.DB.prepare(
			"SELECT COUNT(*) AS count FROM issued_labels WHERE idempotency_key = ?",
		)
			.bind("decision-atomic:label:0")
			.first<{ count: number }>();
		expect(action).toBeNull();
		expect(partial?.count).toBe(0);
	});

	it("does not negate an approved pass for a different CID", async () => {
		const issuer = await createTestIssuer(env.DB);
		const uri = `${PROFILE_URI}-cid-regression`;
		const approvedCid = SUBJECT_CID;
		const pendingCid = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
		await issuer.approve(decisionContext("cid-a"), {
			kind: "profile",
			uri,
			cid: approvedCid,
		});
		const blocked = await issuer.block(decisionContext("cid-b"), {
			kind: "profile",
			uri,
			cid: pendingCid,
		});
		expect(blocked.labels).toHaveLength(1);
		expect(blocked.labels[0]?.label).toEqual(
			expect.objectContaining({ val: "listing-blocked", cid: pendingCid }),
		);
		const pass = await env.DB.prepare(
			`SELECT cid, neg FROM issued_labels
			 WHERE src = ? AND uri = ? AND val = 'listing-passed'
			 ORDER BY sequence DESC LIMIT 1`,
		)
			.bind(ISSUER_DID, uri)
			.first<{ cid: string; neg: number }>();
		expect(pass).toEqual({ cid: approvedCid, neg: 0 });
	});

	it("uses serialized decision order when a requested creation time is stale", async () => {
		const issuer = await createTestIssuer(env.DB);
		const subject = {
			...PROFILE_SUBJECT,
			uri: `${PROFILE_SUBJECT.uri}-reordered-commit`,
		};
		const approved = await issuer.approve(
			decisionContext("reordered-approve"),
			subject,
			new Date("2026-08-24T14:00:00.000Z"),
		);
		const staleBlock = await issuer.block(
			decisionContext("reordered-older-block"),
			subject,
			new Date("2026-08-24T13:00:00.000Z"),
		);
		expect(Date.parse(staleBlock.labels[0]!.label.cts)).toBeGreaterThan(
			Date.parse(approved.labels[0]!.label.cts),
		);
		const decision = await issuer.block(
			decisionContext("reordered-new-block"),
			subject,
			new Date("2026-08-24T15:00:00.000Z"),
		);
		expect(decision.labels.map((label) => [label.label.val, label.label.neg === true])).toEqual([
			["listing-blocked", false],
		]);
	});

	it("serializes opposite decisions and advances their creation times", async () => {
		const issuer = await createTestIssuer(env.DB);
		const subject = {
			...PROFILE_SUBJECT,
			uri: `${PROFILE_SUBJECT.uri}-cts-collision`,
		};
		const collisionTime = new Date("2026-08-24T16:00:00.000Z");
		const approved = await issuer.approve(
			decisionContext("collision-approve-one"),
			subject,
			collisionTime,
		);
		const blocked = await issuer.block(
			decisionContext("collision-block-one"),
			subject,
			collisionTime,
		);
		const approvedAgain = await issuer.approve(
			decisionContext("collision-approve-two"),
			subject,
			collisionTime,
		);
		expect(Date.parse(blocked.labels[0]!.label.cts)).toBeGreaterThan(
			Date.parse(approved.labels[0]!.label.cts),
		);
		expect(Date.parse(approvedAgain.labels[0]!.label.cts)).toBeGreaterThan(
			Date.parse(blocked.labels[0]!.label.cts),
		);

		const rows = await env.DB.prepare(
			`SELECT ver, src, uri, cid, val, neg, cts, exp
			 FROM issued_labels WHERE uri = ? ORDER BY sequence`,
		)
			.bind(subject.uri)
			.all<{
				ver: 1;
				src: string;
				uri: string;
				cid: string;
				val: string;
				neg: number;
				cts: string;
				exp: string | null;
			}>();
		const reduction = reduceListingLabels(
			rows.results.map((row) => ({
				ver: row.ver,
				src: row.src,
				uri: row.uri,
				cid: row.cid,
				val: row.val,
				...(row.neg === 1 ? { neg: true } : {}),
				cts: row.cts,
				...(row.exp === null ? {} : { exp: row.exp }),
			})),
			approvedAgain.labels[0]!.label.cts,
		);
		expect(reduction.states.find(({ winner }) => winner.val === "listing-passed")).toMatchObject({
			active: true,
			collision: [],
		});
		expect(reduction.states.find(({ winner }) => winner.val === "listing-blocked")).toMatchObject({
			active: false,
			collision: [],
		});
	});

	it("keeps committed labels pending when live publication fails", async () => {
		const publicationError = vi.fn();
		const issuer = await createTestIssuer(env.DB, {
			publicationTarget: { notify: vi.fn().mockRejectedValue(new Error("offline")) },
			onPublicationError: publicationError,
		});
		const decision = await issuer.approve(decisionContext("publication-failure"), PROFILE_SUBJECT);
		expect(decision.labels.every((label) => label.publicationPending)).toBe(true);
		expect(publicationError).toHaveBeenCalledTimes(2);
		const row = await env.DB.prepare(
			"SELECT publication_pending FROM issued_labels WHERE sequence = ?",
		)
			.bind(decision.labels.at(-1)?.sequence)
			.first<{ publication_pending: number }>();
		expect(row?.publication_pending).toBe(1);
	});

	it("atomically rejects operator labels after the observed subject is deleted", async () => {
		const uri = `${PROFILE_URI}-deleted-operator-race`;
		await seedAssessment(env.DB, { id: "deleted-operator-race", state: "review", uri });
		await env.DB.batch([
			env.DB.prepare("UPDATE subjects SET deleted_at = ? WHERE uri = ?").bind(
				"2026-08-24T18:00:00.000Z",
				uri,
			),
			env.DB.prepare("UPDATE current_subjects SET deleted_at = ? WHERE uri = ?").bind(
				"2026-08-24T18:00:00.000Z",
				uri,
			),
		]);
		const issuer = await createTestIssuer(env.DB, { requireObservedOperatorSubjects: true });
		await expect(
			issuer.approve(decisionContext("deleted-operator-race"), {
				...PROFILE_SUBJECT,
				uri,
			}),
		).rejects.toThrow();
		expect(
			await env.DB.prepare("SELECT id FROM operator_actions WHERE idempotency_key = ?")
				.bind("decision-deleted-operator-race")
				.first(),
		).toBeNull();
	});

	it("atomically rejects operator labels after a newer CID becomes current", async () => {
		const uri = `${PROFILE_URI}-superseded-operator-race`;
		const currentCid = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
		const observedAt = "2026-08-24T18:00:00.000Z";
		await seedAssessment(env.DB, { id: "superseded-operator-race", state: "review", uri });
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO subjects
				   (uri, cid, kind, publisher_did, first_observed_at, last_observed_at)
				 VALUES (?, ?, 'profile', 'did:example:publisher', ?, ?)`,
			).bind(uri, currentCid, observedAt, observedAt),
			env.DB.prepare("UPDATE current_subjects SET cid = ?, updated_at = ? WHERE uri = ?").bind(
				currentCid,
				observedAt,
				uri,
			),
		]);
		const issuer = await createTestIssuer(env.DB, { requireObservedOperatorSubjects: true });
		await expect(
			issuer.approve(decisionContext("superseded-operator-race"), {
				...PROFILE_SUBJECT,
				uri,
			}),
		).rejects.toThrow();
		expect(
			await env.DB.prepare("SELECT id FROM operator_actions WHERE idempotency_key = ?")
				.bind("decision-superseded-operator-race")
				.first(),
		).toBeNull();
	});

	it("refuses to start when the private key does not match the DID document", async () => {
		await expect(
			createTestIssuer(env.DB, {
				resolveDid: async () => ({
					id: ISSUER_DID,
					verificationMethod: [
						{
							id: "#atproto_label",
							type: "Multikey",
							controller: ISSUER_DID,
							publicKeyMultibase: "zDnaer52RTwabaBeMkKYYwZmEFqPabLW78cRK62iovMUQhFif",
						},
					],
				}),
			}),
		).rejects.toThrow("privateKey does not match");
	});
});
