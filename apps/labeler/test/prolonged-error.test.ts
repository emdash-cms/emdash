import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";
import {
	buildMarkOperatorAlerted,
	ensureEscalationRow,
	findEscalatableErrors,
	getEscalation,
} from "../src/assessment-error-escalations.js";
import { computeRunKey, initialTriggerId, intelTriggerId } from "../src/assessment-lifecycle.js";
import type { Assessment } from "../src/assessment-store.js";
import {
	buildFinalizationStatements,
	createAssessmentRun,
	createSubject,
	deleteSubject,
	transitionAssessmentState,
} from "../src/assessment-store.js";
import {
	confirmContact,
	ensureContact,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
} from "../src/notification-contacts.js";
import type { ConfirmationPayload, NoticePayload, SendResult } from "../src/notification-send.js";
import {
	notifyAssessmentOutcome,
	resolveNoticeForSource,
	type NotifyDeps,
} from "../src/notification-triggers.js";
import { buildOperationalEventInsert, newOperationalEventId } from "../src/operational-events.js";
import { runProlongedErrorEscalation } from "../src/prolonged-error.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "prolonged-pepper";
const SERVICE = "https://labels.example";
const RECON = "https://recon.example/reconsider";
const SRC = "did:plc:labeler000000000000000000";
const PUBLISHER_DID = "did:plc:publisher000000000000000000";
const NOW = new Date("2026-07-17T00:00:00.000Z");
const H = 60 * 60 * 1000;

let counter = 0;
const uniq = (p: string) => `${p}-${++counter}`;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

function release(): { uri: string; cid: string } {
	counter++;
	return {
		uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/pe-${counter}:1.0.0`,
		cid: `bafkreipe${counter}0000000000000000000000000000000000000000000`,
	};
}

async function subject(target: { uri: string; cid: string }): Promise<void> {
	await createSubject(db(), {
		uri: target.uri,
		cid: target.cid,
		did: PUBLISHER_DID,
		collection: "com.emdashcms.experimental.package.release",
		rkey: target.uri.split("/").at(-1)!,
	});
}

/** Drives a run all the way to the terminal `error` state, controlling both the
 * `created_at` (supersession ordering) and `completed_at` (escalation timing). */
async function errorAssessment(
	target: { uri: string; cid: string },
	opts: { createdAt: Date; completedAt: Date; triggerId?: string },
): Promise<string> {
	const triggerId = opts.triggerId ?? initialTriggerId(target.cid);
	const runKey = await computeRunKey({
		uri: target.uri,
		cid: target.cid,
		policyVersion: "v1",
		modelId: "m",
		promptHash: "p",
		scannerSetVersion: "v1",
		triggerId,
	});
	const { assessment } = await createAssessmentRun(db(), {
		runKey,
		uri: target.uri,
		cid: target.cid,
		trigger: "initial",
		triggerId,
		policyVersion: "v1",
		coverageJson: "{}",
		now: opts.createdAt,
	});
	const id = assessment.id;
	await transitionAssessmentState(db(), {
		id,
		from: "observed",
		to: "verifying",
		now: opts.createdAt,
	});
	await transitionAssessmentState(db(), {
		id,
		from: "verifying",
		to: "pending",
		now: opts.createdAt,
	});
	await transitionAssessmentState(db(), {
		id,
		from: "pending",
		to: "running",
		now: opts.createdAt,
	});
	const fin = buildFinalizationStatements(db(), {
		assessmentId: id,
		fromState: "running",
		toState: "error",
		src: SRC,
		uri: target.uri,
		cid: target.cid,
		now: opts.completedAt,
	});
	await db().batch(fin.statements);
	return id;
}

interface RecordingSender {
	confirmations: ConfirmationPayload[];
	notices: NoticePayload[];
	sendConfirmation(p: ConfirmationPayload): Promise<SendResult>;
	sendNotice(p: NoticePayload): Promise<SendResult>;
}

function recordingSender(result: SendResult = { ok: true, providerId: "p" }): RecordingSender {
	const confirmations: ConfirmationPayload[] = [];
	const notices: NoticePayload[] = [];
	return {
		confirmations,
		notices,
		sendConfirmation: async (p) => (confirmations.push(p), result),
		sendNotice: async (p) => (notices.push(p), result),
	};
}

function aggregatorFor(email?: string): AggregatorClient {
	const fetcher = {
		fetch: async (url: string) => {
			if (url.includes("getPublisherVerification"))
				return Response.json({ did: PUBLISHER_DID, verifications: [], labels: [] });
			if (url.includes("getPublisher") && email !== undefined)
				return Response.json({
					did: PUBLISHER_DID,
					profile: { contact: [{ kind: "security", email }] },
				});
			return new Response(JSON.stringify({ error: "NotFound" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		},
	} as unknown as Fetcher;
	return new AggregatorClient(fetcher);
}

/** An aggregator whose reads THROW — drives a transient pre-claim failure in
 * `resolvePublisherContact` (which propagates rather than returning `none`). */
function throwingAggregator(): AggregatorClient {
	return new AggregatorClient({
		fetch: async () => {
			throw new Error("aggregator down");
		},
	} as unknown as Fetcher);
}

function deps(sender: RecordingSender, aggregator: AggregatorClient): NotifyDeps {
	return {
		db: db(),
		aggregator,
		sender,
		pepper: PEPPER,
		serviceUrl: SERVICE,
		reconsiderationUrl: RECON,
		now: () => NOW,
	};
}

async function seedConfirmed(email: string): Promise<void> {
	const hash = await recipientHash(PEPPER, email);
	await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
	const th = await hashConfirmToken("seed");
	await recordConfirmSent(db(), hash, th, 1_000);
	await confirmContact(db(), hash, th, "2026-07-16T00:00:01.000Z");
}

async function operatorAlertCount(uri: string): Promise<number> {
	const row = await db()
		.prepare(
			`SELECT COUNT(*) AS n FROM operational_events
			 WHERE event_type = 'assessment-prolonged-error' AND subject_uri = ?`,
		)
		.bind(uri)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function notificationRows(sourceId: string): Promise<{ kind: string; state: string }[]> {
	const r = await db()
		.prepare(`SELECT kind, state FROM notifications WHERE source_id = ?`)
		.bind(sourceId)
		.all<{ kind: string; state: string }>();
	return r.results ?? [];
}

describe("operator alert stage (24h)", () => {
	it("fires an operator alert once the error is 24h old, not before", async () => {
		const fresh = release();
		await subject(fresh);
		await errorAssessment(fresh, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 23 * H),
		});

		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);
		expect(await operatorAlertCount(fresh.uri)).toBe(0);

		const stale = release();
		await subject(stale);
		await errorAssessment(stale, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 25 * H),
		});

		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);
		expect(await operatorAlertCount(stale.uri)).toBe(1);
	});

	it("records the alert as severity high with a public-safe payload", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 25 * H),
		});

		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);

		const row = await db()
			.prepare(
				`SELECT severity, action_id, payload_json FROM operational_events
				 WHERE event_type = 'assessment-prolonged-error' AND subject_uri = ?`,
			)
			.bind(target.uri)
			.first<{ severity: string; action_id: string | null; payload_json: string }>();
		expect(row?.severity).toBe("high");
		expect(row?.action_id).toBeNull();
		const payload = JSON.parse(row?.payload_json ?? "{}") as Record<string, unknown>;
		expect(payload).toEqual({ assessmentId: id, cid: target.cid });
	});

	it("is idempotent across repeated cron ticks (exactly one event)", async () => {
		const target = release();
		await subject(target);
		await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 25 * H),
		});

		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);
		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);
		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor()), NOW);

		expect(await operatorAlertCount(target.uri)).toBe(1);
	});

	it("inserts exactly one operator event when two overlapping passes both read it unalerted", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 25 * H),
		});
		await ensureEscalationRow(db(), {
			assessmentId: id,
			subjectUri: target.uri,
			subjectCid: target.cid,
			now: NOW,
		});
		// Both passes observe operator_alerted null (cron ticks are not serialized),
		// then each commits its gated event+mark batch. The in-batch EXISTS gate — not
		// the stale app-level read — must admit only the first.
		expect((await getEscalation(db(), id))?.operatorAlertedAtEpochMs).toBeNull();
		expect((await getEscalation(db(), id))?.operatorAlertedAtEpochMs).toBeNull();
		const commitAlertBatch = () =>
			db().batch([
				buildOperationalEventInsert(db(), {
					id: newOperationalEventId(),
					eventType: "assessment-prolonged-error",
					severity: "high",
					actionId: null,
					subjectUri: target.uri,
					payload: { assessmentId: id, cid: target.cid },
					now: NOW,
					gateOnUnalertedEscalation: { assessmentId: id },
				}),
				buildMarkOperatorAlerted(db(), id, NOW),
			]);

		await commitAlertBatch();
		await commitAlertBatch();

		expect(await operatorAlertCount(target.uri)).toBe(1);
	});

	it("drops a fully-escalated row from the scan window so newer errors are reached", async () => {
		const done = release();
		await subject(done);
		const doneId = await errorAssessment(done, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 73 * H),
		});
		const email = uniq("win") + "@x.test";
		await seedConfirmed(email);
		await runProlongedErrorEscalation(deps(recordingSender(), aggregatorFor(email)), NOW);

		// Both marks are now set, so the oldest (by completed_at) row leaves the window.
		const escalation = await getEscalation(db(), doneId);
		expect(escalation?.operatorAlertedAtEpochMs).not.toBeNull();
		expect(escalation?.publisherNotifiedAtEpochMs).not.toBeNull();
		expect((await findEscalatableErrors(db(), NOW)).some((e) => e.id === doneId)).toBe(false);

		// A newer error behind it in completed_at order is still reached.
		const fresh = release();
		await subject(fresh);
		const freshId = await errorAssessment(fresh, {
			createdAt: new Date(NOW.getTime() - 30 * H),
			completedAt: new Date(NOW.getTime() - 25 * H),
		});
		const found = await findEscalatableErrors(db(), NOW);
		expect(found.some((e) => e.id === freshId)).toBe(true);
		expect(found.some((e) => e.id === doneId)).toBe(false);
	});

	it("does not escalate a superseded error at all", async () => {
		const target = release();
		await subject(target);
		await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 80 * H),
		});
		// A newer run for the SAME (uri, cid) supersedes the error.
		await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 10 * H),
			completedAt: new Date(NOW.getTime() - 5 * H),
			triggerId: intelTriggerId("corpus-v2"),
		});

		const sender = recordingSender();
		await runProlongedErrorEscalation(deps(sender, aggregatorFor("s@x.test")), NOW);

		expect(await operatorAlertCount(target.uri)).toBe(0);
		expect(sender.notices).toHaveLength(0);
	});

	it("does not escalate an error whose subject was deleted at the source", async () => {
		const target = release();
		await subject(target);
		await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 80 * H),
		});
		await deleteSubject(db(), { uri: target.uri, cid: target.cid });

		const sender = recordingSender();
		await runProlongedErrorEscalation(deps(sender, aggregatorFor("s@x.test")), NOW);

		expect(await operatorAlertCount(target.uri)).toBe(0);
		expect(sender.notices).toHaveLength(0);
	});
});

describe("publisher notice stage (72h)", () => {
	it("does not notify the publisher before 72h", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 80 * H),
			completedAt: new Date(NOW.getTime() - 71 * H),
		});
		const email = uniq("early") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();

		await runProlongedErrorEscalation(deps(sender, aggregatorFor(email)), NOW);

		expect(await operatorAlertCount(target.uri)).toBe(1);
		expect(sender.notices).toHaveLength(0);
		expect(await notificationRows(id)).toHaveLength(0);
	});

	it("notifies a confirmed publisher once past 72h, exactly once across ticks", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 73 * H),
		});
		const email = uniq("late") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const d = deps(sender, aggregatorFor(email));

		await runProlongedErrorEscalation(d, NOW);
		await runProlongedErrorEscalation(d, NOW);

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]).toMatchObject({
			to: email,
			subject: expect.stringContaining("couldn't complete"),
		});
		expect(await notificationRows(id)).toEqual([{ kind: "notice", state: "sent" }]);
	});

	it("gates an unconfirmed publisher through double opt-in (confirmation only)", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 73 * H),
		});
		const email = uniq("unconf") + "@x.test";
		const sender = recordingSender();

		await runProlongedErrorEscalation(deps(sender, aggregatorFor(email)), NOW);

		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(1);
		expect(await notificationRows(id)).toEqual([{ kind: "confirmation", state: "sent" }]);
	});

	it("does not mark on a transient pre-claim failure, and retries on the next tick", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 73 * H),
		});
		const email = uniq("retry") + "@x.test";
		await seedConfirmed(email);

		// Tick 1: the aggregator read throws inside resolvePublisherContact, before any
		// notifications row is claimed. The trigger swallows it and returns false, so
		// nothing is claimed and publisher_notified_at stays null.
		await runProlongedErrorEscalation(deps(recordingSender(), throwingAggregator()), NOW);
		expect((await getEscalation(db(), id))?.publisherNotifiedAtEpochMs).toBeNull();
		expect(await notificationRows(id)).toHaveLength(0);

		// Tick 2: the aggregator is healthy → the notice is claimed and sent, and the
		// mark is stamped. A transient failure retried rather than being swallowed.
		const sender = recordingSender();
		await runProlongedErrorEscalation(deps(sender, aggregatorFor(email)), NOW);
		expect(sender.notices).toHaveLength(1);
		expect(await notificationRows(id)).toEqual([{ kind: "notice", state: "sent" }]);
		expect((await getEscalation(db(), id))?.publisherNotifiedAtEpochMs).not.toBeNull();
	});
});

describe("sweep parity and finalization invariant", () => {
	it("resolveNoticeForSource re-renders the prolonged-error content for an errored run", async () => {
		const target = release();
		await subject(target);
		const id = await errorAssessment(target, {
			createdAt: new Date(NOW.getTime() - 100 * H),
			completedAt: new Date(NOW.getTime() - 73 * H),
		});

		const notice = await resolveNoticeForSource(
			deps(recordingSender(), aggregatorFor()),
			"issuance",
			id,
		);

		expect(notice).not.toBeNull();
		expect(notice?.subject).toContain("couldn't complete");
		expect(new URL(notice!.assessmentUrl).origin).toBe(SERVICE);
	});

	it("notifyAssessmentOutcome never notifies on an error assessment (finalization stays silent)", async () => {
		const sender = recordingSender();
		const assessment = {
			id: uniq("asmt"),
			uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/fin1`,
			cid: "bafyerr",
			state: "error",
			publicSummary: "irrelevant",
		} as unknown as Assessment;

		await notifyAssessmentOutcome(deps(sender, aggregatorFor("s@x.test")), assessment);

		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(0);
		expect(await notificationRows(assessment.id)).toHaveLength(0);
	});
});
