import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import {
	SERVICE_CONTROL_OBJECT_NAME,
	type SetServiceModeInput,
} from "../src/control-do/service-control-do.js";

const DID = "did:plc:publisher";
const INTENT_ID = "intent-01JABCDEFGHJKMNPQRSTVWXYZ";
const NOW = 1_800_000_000_000;
const VIEWER = {
	realm: "access",
	identity: "7335d417-61da-459d-899c-0a01c76a2f94",
	email: "viewer@example.com",
	role: "viewer",
} as const satisfies AccessActor;
const ADMIN = {
	...VIEWER,
	email: "admin@example.com",
	role: "admin",
} as const satisfies AccessActor;

function control() {
	return env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
}

function modeInput(overrides: Partial<SetServiceModeInput> = {}): SetServiceModeInput {
	return {
		actor: ADMIN,
		idempotencyKey: "operator-request-0001",
		requestDigest: "A".repeat(43),
		mode: "publication-paused",
		reasonCode: "MAINTENANCE",
		now: NOW,
		...overrides,
	};
}

afterEach(async () => {
	await reset();
});

describe("ServiceControlDurableObject", () => {
	it("starts active and admits an unsuspended publisher", async () => {
		const stub = control();

		await expect(stub.readServiceState(VIEWER)).resolves.toEqual({
			mode: "active",
			epoch: 1,
			reasonCode: null,
			changedBy: "system:bootstrap",
			changedAt: 0,
		});
		await expect(stub.getAdmissionDecision(DID)).resolves.toEqual({
			allowed: true,
			mode: "active",
			modeEpoch: 1,
			code: null,
		});
		await expect(stub.readPublisherControl(VIEWER, DID)).resolves.toEqual({
			publisherDid: DID,
			status: "allowed",
			reasonCode: null,
			changedBy: "system:default",
			changedAt: 0,
		});
	});

	it("changes mode atomically and replays an operator mutation once", async () => {
		const stub = control();
		const input = modeInput();

		const first = await stub.setServiceMode(input);
		expect(first).toEqual({
			ok: true,
			replayed: false,
			value: {
				mode: "publication-paused",
				epoch: 2,
				reasonCode: "MAINTENANCE",
				changedBy: ADMIN.identity,
				changedAt: NOW,
			},
		});
		await expect(stub.setServiceMode(input)).resolves.toEqual({ ...first, replayed: true });
		await expect(stub.setServiceMode({ ...input, requestDigest: "B".repeat(43) })).resolves.toEqual(
			{ ok: false, code: "IDEMPOTENCY_CONFLICT" },
		);

		const audit = await stub.listAudit(VIEWER);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			eventType: "service-mode-changed",
			actorRealm: "access",
			actorIdentity: ADMIN.identity,
			actorRole: "admin",
			subject: "publication-paused",
			reasonCode: "MAINTENANCE",
		});
	});

	it("rejects insufficient operators and incomplete pause reasons", async () => {
		const stub = control();

		await runInDurableObject(stub, async (instance) => {
			await expect(instance.setServiceMode(modeInput({ actor: VIEWER }))).rejects.toMatchObject({
				code: "CONTROL_ACTOR_INVALID",
			});
			await expect(instance.setServiceMode(modeInput({ reasonCode: null }))).rejects.toMatchObject({
				code: "CONTROL_INPUT_INVALID",
			});
			await expect(
				instance.setServiceMode(modeInput({ mode: "active", reasonCode: "MAINTENANCE" })),
			).rejects.toMatchObject({ code: "CONTROL_INPUT_INVALID" });
		});
	});

	it("applies admission and publication pauses independently", async () => {
		const stub = control();
		await stub.setServiceMode(modeInput({ mode: "admission-paused", reasonCode: "MAINTENANCE" }));

		await expect(stub.getAdmissionDecision(DID)).resolves.toMatchObject({
			allowed: false,
			mode: "admission-paused",
			code: "ADMISSION_PAUSED",
		});
		const admittedPermit = await stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW + 1);
		expect(admittedPermit).toMatchObject({ ok: true, permit: { modeEpoch: 2 } });

		await stub.setServiceMode(
			modeInput({
				idempotencyKey: "operator-request-0002",
				requestDigest: "B".repeat(43),
				mode: "publication-paused",
				now: NOW + 2,
			}),
		);
		await expect(stub.getAdmissionDecision(DID)).resolves.toMatchObject({
			allowed: true,
			mode: "publication-paused",
			code: null,
		});
		await expect(stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW + 3)).resolves.toEqual({
			ok: false,
			code: "PUBLICATION_PAUSED",
		});
	});

	it("issues a bound permit that can be consumed exactly once", async () => {
		const stub = control();
		const issued = await stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		await expect(
			stub.consumePublicationPermit({
				...issued.permit,
				now: NOW + 1,
			}),
		).resolves.toEqual({ ok: true, modeEpoch: 1 });
		await expect(
			stub.consumePublicationPermit({
				...issued.permit,
				now: NOW + 2,
			}),
		).resolves.toEqual({ ok: false, code: "PERMIT_CONSUMED" });
		await expect(
			stub.consumePublicationPermit({
				...issued.permit,
				token: `${"A".repeat(42)}B`,
				now: NOW + 2,
			}),
		).resolves.toEqual({ ok: false, code: "PERMIT_INVALID" });
	});

	it("invalidates a cached permit when the service mode epoch changes", async () => {
		const stub = control();
		const issued = await stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		await stub.setServiceMode(
			modeInput({ mode: "admission-paused", reasonCode: "MAINTENANCE", now: NOW + 1 }),
		);

		await expect(
			stub.consumePublicationPermit({ ...issued.permit, now: NOW + 2 }),
		).resolves.toEqual({ ok: false, code: "PERMIT_STALE" });
	});

	it("suspends publisher admission and invalidates outstanding permits", async () => {
		const stub = control();
		const issued = await stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		await expect(
			stub.setPublisherControl({
				actor: ADMIN,
				idempotencyKey: "operator-request-0001",
				requestDigest: "A".repeat(43),
				publisherDid: DID,
				status: "suspended",
				reasonCode: "SECURITY_REVIEW",
				now: NOW + 1,
			}),
		).resolves.toMatchObject({
			ok: true,
			value: { publisherDid: DID, status: "suspended", reasonCode: "SECURITY_REVIEW" },
		});
		await expect(stub.getAdmissionDecision(DID)).resolves.toMatchObject({
			allowed: false,
			code: "PUBLISHER_SUSPENDED",
		});
		await expect(stub.issuePublicationPermit(DID, "intent-2", 5_000, NOW + 2)).resolves.toEqual({
			ok: false,
			code: "PUBLISHER_SUSPENDED",
		});
		await expect(
			stub.consumePublicationPermit({ ...issued.permit, now: NOW + 2 }),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SUSPENDED" });
	});

	it("never persists a plaintext permit token", async () => {
		const stub = control();
		const issued = await stub.issuePublicationPermit(DID, INTENT_ID, 5_000, NOW);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		const persisted = await runInDurableObject(stub, (_instance, state) => ({
			permit: state.storage.sql
				.exec<{ token_hash: string }>(
					"SELECT token_hash FROM publication_permits WHERE id = ?",
					issued.permit.id,
				)
				.one(),
			audit: state.storage.sql
				.exec<{ public_payload: string }>("SELECT public_payload FROM audit_events")
				.toArray(),
		}));
		expect(persisted.permit.token_hash).not.toBe(issued.permit.token);
		expect(JSON.stringify(persisted)).not.toContain(issued.permit.token);
	});

	it("cleans expired permits and operator idempotency with its alarm", async () => {
		const stub = control();
		const oldNow = Date.now() - 24 * 60 * 60_000 - 1_000;
		await stub.issuePublicationPermit(DID, INTENT_ID, 1, oldNow);
		await stub.setServiceMode(
			modeInput({
				mode: "admission-paused",
				reasonCode: "MAINTENANCE",
				now: oldNow,
			}),
		);

		await runDurableObjectAlarm(stub);
		const counts = await runInDurableObject(stub, (_instance, state) => ({
			permits: state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication_permits")
				.one().count,
			idempotency: state.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operator_idempotency")
				.one().count,
		}));
		expect(counts).toEqual({ permits: 0, idempotency: 0 });
	});

	it("rejects calls routed to a non-canonical control object", async () => {
		const unnamed = env.SERVICE_CONTROL_DO.get(env.SERVICE_CONTROL_DO.newUniqueId());

		await runInDurableObject(unnamed, async (instance) => {
			await expect(instance.readServiceState(VIEWER)).rejects.toMatchObject({
				code: "CONTROL_OBJECT_MISMATCH",
			});
		});
	});
});
