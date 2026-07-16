import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { AggregatorClient } from "../src/aggregator-client.js";
import type { Assessment } from "../src/assessment-store.js";
import {
	confirmContact,
	ensureContact,
	hashConfirmToken,
	recipientHash,
	recordConfirmSent,
	suppress,
} from "../src/notification-contacts.js";
import type { ConfirmationPayload, NoticePayload, SendResult } from "../src/notification-send.js";
import {
	notifyAssessmentOutcome,
	notifyEmergencyTakedown,
	notifyOperatorLabel,
	notifyOverride,
	notifyOverrideRetract,
	type NotifyDeps,
} from "../src/notification-triggers.js";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;
const db = () => testEnv.DB;

const PEPPER = "trig-pepper";
const SERVICE = "https://labels.example";
const RECON = "https://recon.example/reconsider";
const DID = "did:plc:x";
const RELEASE_URI = `at://${DID}/com.emdashcms.experimental.package.release/rel1`;

let counter = 0;
const uniq = (p: string) => `${p}-${++counter}`;

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

interface AggregatorOpts {
	email?: string;
	verifications?: unknown[];
	verifyStatus?: number;
}

function aggregatorFor(opts: AggregatorOpts): AggregatorClient {
	const fetcher = {
		fetch: async (url: string) => {
			if (url.includes("getPublisherVerification")) {
				if (opts.verifyStatus !== undefined && opts.verifyStatus !== 200)
					return new Response("err", { status: opts.verifyStatus });
				return Response.json({ did: DID, verifications: opts.verifications ?? [], labels: [] });
			}
			if (url.includes("getPublisher") && opts.email !== undefined) {
				return Response.json({
					did: DID,
					profile: { contact: [{ kind: "security", email: opts.email }] },
				});
			}
			return new Response(JSON.stringify({ error: "NotFound" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});
		},
	} as unknown as Fetcher;
	return new AggregatorClient(fetcher);
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
		sendConfirmation: async (p) => {
			confirmations.push(p);
			return result;
		},
		sendNotice: async (p) => {
			notices.push(p);
			return result;
		},
	};
}

function throwingSender(): RecordingSender {
	return {
		confirmations: [],
		notices: [],
		sendConfirmation: async () => {
			throw new Error("transport exploded");
		},
		sendNotice: async () => {
			throw new Error("transport exploded");
		},
	};
}

function deps(aggregator: AggregatorClient, sender: RecordingSender): NotifyDeps {
	return {
		db: db(),
		aggregator,
		sender,
		pepper: PEPPER,
		serviceUrl: SERVICE,
		reconsiderationUrl: RECON,
	};
}

function assessmentRow(overrides: Partial<Assessment>): Assessment {
	return {
		id: uniq("asmt"),
		uri: RELEASE_URI,
		cid: "bafycid",
		state: "blocked",
		publicSummary: "A finding was reported.",
		...overrides,
	} as unknown as Assessment;
}

async function seedConfirmed(email: string): Promise<string> {
	const hash = await recipientHash(PEPPER, email);
	await ensureContact(db(), hash, "2026-07-16T00:00:00.000Z");
	const th = await hashConfirmToken("seed");
	await recordConfirmSent(db(), hash, th, 1_000);
	await confirmContact(db(), hash, th, "2026-07-16T00:00:01.000Z");
	return hash;
}

async function notificationRows(sourceId: string): Promise<{ kind: string; state: string }[]> {
	const r = await db()
		.prepare(`SELECT kind, state FROM notifications WHERE source_id = ?`)
		.bind(sourceId)
		.all<{ kind: string; state: string }>();
	return r.results ?? [];
}

const IN_FORCE = [
	{ issuer: "did:plc:issuer", handle: "x.test", createdAt: "2026-01-01T00:00:00.000Z" },
];
const EXPIRED = [
	{
		issuer: "did:plc:issuer",
		handle: "x.test",
		createdAt: "2020-01-01T00:00:00.000Z",
		expiresAt: "2021-01-01T00:00:00.000Z",
	},
];

describe("the five events each notify a confirmed publisher", () => {
	it("automated block → notice from source 'issuance'", async () => {
		const email = uniq("blk") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });

		await notifyAssessmentOutcome(deps(aggregatorFor({ email }), sender), a);

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]).toMatchObject({
			to: email,
			subject: expect.stringContaining("blocked"),
		});
		expect(await notificationRows(a.id)).toEqual([{ kind: "notice", state: "sent" }]);
	});

	it("automated warning → notice", async () => {
		const email = uniq("warn") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const a = assessmentRow({ state: "warned" });

		await notifyAssessmentOutcome(deps(aggregatorFor({ email }), sender), a);

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]?.effect).toContain("warning");
	});

	it("passed outcome does NOT notify", async () => {
		const email = uniq("pass") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const a = assessmentRow({ state: "passed" });

		await notifyAssessmentOutcome(deps(aggregatorFor({ email }), sender), a);

		expect(sender.notices).toHaveLength(0);
		expect(await notificationRows(a.id)).toHaveLength(0);
	});

	it("operator label issue → notice from source 'operator'", async () => {
		const email = uniq("lbl") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const actionId = uniq("oact");

		await notifyOperatorLabel(deps(aggregatorFor({ email }), sender), {
			actionId,
			uri: RELEASE_URI,
			cid: "bafycid",
			val: "security-yanked",
			neg: false,
		});

		expect(sender.notices).toHaveLength(1);
		expect(await notificationRows(actionId)).toEqual([{ kind: "notice", state: "sent" }]);
	});

	it("operator override → notice", async () => {
		const email = uniq("ovr") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const actionId = uniq("oact");

		await notifyOverride(deps(aggregatorFor({ email }), sender), {
			actionId,
			uri: RELEASE_URI,
			cid: "bafycid",
		});

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]?.subject).toContain("unblocked");
	});

	it("operator override-retract → notice", async () => {
		const email = uniq("ovrr") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const actionId = uniq("oact");

		await notifyOverrideRetract(deps(aggregatorFor({ email }), sender), {
			actionId,
			uri: RELEASE_URI,
			cid: "bafycid",
		});

		expect(sender.notices).toHaveLength(1);
	});

	it("emergency takedown → notice", async () => {
		const email = uniq("td") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const actionId = uniq("oact");

		await notifyEmergencyTakedown(deps(aggregatorFor({ email }), sender), {
			actionId,
			uri: RELEASE_URI,
			neg: false,
		});

		expect(sender.notices).toHaveLength(1);
		expect(sender.notices[0]?.subject).toContain("taken down");
	});
});

describe("dedup", () => {
	it("an unchanged re-run for the same source does not re-notify", async () => {
		const email = uniq("dedup") + "@x.test";
		await seedConfirmed(email);
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });
		const d = deps(aggregatorFor({ email }), sender);

		await notifyAssessmentOutcome(d, a);
		await notifyAssessmentOutcome(d, a);

		expect(sender.notices).toHaveLength(1);
		expect(await notificationRows(a.id)).toHaveLength(1);
	});
});

describe("verified-publisher skip", () => {
	it("an in-force verification claim delivers the notice without a confirmation mail", async () => {
		const email = uniq("vok") + "@x.test";
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });

		// The contact is UNCONFIRMED; verification upgrades it in place.
		await notifyAssessmentOutcome(
			deps(aggregatorFor({ email, verifications: IN_FORCE }), sender),
			a,
		);

		expect(sender.notices).toHaveLength(1);
		expect(sender.confirmations).toHaveLength(0);
		const hash = await recipientHash(PEPPER, email);
		const contact = await db()
			.prepare(`SELECT confirm_state FROM notification_contacts WHERE recipient_hash = ?`)
			.bind(hash)
			.first<{ confirm_state: string }>();
		expect(contact?.confirm_state).toBe("confirmed");
	});

	it("an EXPIRED claim falls back to double opt-in", async () => {
		const email = uniq("vexp") + "@x.test";
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });

		await notifyAssessmentOutcome(
			deps(aggregatorFor({ email, verifications: EXPIRED }), sender),
			a,
		);

		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(1);
	});

	it("a verification read failure fails closed to double opt-in", async () => {
		const email = uniq("vfail") + "@x.test";
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });

		await notifyAssessmentOutcome(deps(aggregatorFor({ email, verifyStatus: 500 }), sender), a);

		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(1);
	});

	it("a suppressed address gets NOTHING even when the publisher is verified", async () => {
		const email = uniq("vsupp") + "@x.test";
		const hash = await recipientHash(PEPPER, email);
		await suppress(db(), hash, "not_me", "2026-07-16T00:00:00.000Z", 1_000);
		const sender = recordingSender();
		const a = assessmentRow({ state: "blocked" });

		await notifyAssessmentOutcome(
			deps(aggregatorFor({ email, verifications: IN_FORCE }), sender),
			a,
		);

		expect(sender.notices).toHaveLength(0);
		expect(sender.confirmations).toHaveLength(0);
	});
});

describe("provider hard-bounce", () => {
	it("E_RECIPIENT_SUPPRESSED marks the row undeliverable and suppresses the address", async () => {
		const email = uniq("bounce") + "@x.test";
		await seedConfirmed(email);
		const hash = await recipientHash(PEPPER, email);
		const sender = recordingSender({
			ok: false,
			error: "E_RECIPIENT_SUPPRESSED",
			suppress: "bounce",
		});
		const a = assessmentRow({ state: "blocked" });

		await notifyAssessmentOutcome(deps(aggregatorFor({ email }), sender), a);

		expect(await notificationRows(a.id)).toEqual([{ kind: "notice", state: "undeliverable" }]);
		const supp = await db()
			.prepare(`SELECT reason FROM notification_suppressions WHERE recipient_hash = ?`)
			.bind(hash)
			.first<{ reason: string }>();
		expect(supp?.reason).toBe("bounce");
	});
});

describe("failure isolation", () => {
	it("a sender that THROWS never propagates out of the trigger (the label is safe)", async () => {
		const email = uniq("throw") + "@x.test";
		await seedConfirmed(email);
		const a = assessmentRow({ state: "blocked" });

		await expect(
			notifyAssessmentOutcome(deps(aggregatorFor({ email }), throwingSender()), a),
		).resolves.toBeUndefined();
	});
});
