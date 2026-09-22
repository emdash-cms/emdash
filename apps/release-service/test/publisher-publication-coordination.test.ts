import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const PUBLISHER_DID = "did:plc:publisher";
const FIRST_INTENT = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const SECOND_INTENT = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const FIRST_TOKEN = "A".repeat(43);
const SECOND_TOKEN = "B".repeat(43);
const NOW = 1_800_000_000_000;

function publisher() {
	return env.PUBLISHER_DO.getByName(PUBLISHER_DID);
}

afterEach(async () => {
	await reset();
});

describe("publisher publication coordination", () => {
	it("serializes one package while allowing another package to proceed", async () => {
		const stub = publisher();
		const first = await stub.acquirePublicationCoordination(
			PUBLISHER_DID,
			"gallery",
			FIRST_INTENT,
			1_000,
			FIRST_TOKEN,
			NOW,
		);
		expect(first).toMatchObject({ ok: true, replayed: false });
		if (!first.ok) return;

		await expect(
			stub.acquirePublicationCoordination(
				PUBLISHER_DID,
				"gallery",
				SECOND_INTENT,
				1_000,
				SECOND_TOKEN,
				NOW + 1,
			),
		).resolves.toEqual({
			ok: false,
			code: "PUBLICATION_COORDINATION_BUSY",
			retryAt: NOW + 1_000,
		});
		await expect(
			stub.acquirePublicationCoordination(
				PUBLISHER_DID,
				"forms",
				SECOND_INTENT,
				1_000,
				SECOND_TOKEN,
				NOW + 1,
			),
		).resolves.toMatchObject({ ok: true });
		await expect(
			stub.acquirePublicationCoordination(
				PUBLISHER_DID,
				"gallery",
				FIRST_INTENT,
				1_000,
				FIRST_TOKEN,
				NOW + 2,
			),
		).resolves.toEqual({ ...first, replayed: true });
	});

	it("renews, releases, and fences stale lease holders", async () => {
		const stub = publisher();
		const acquired = await stub.acquirePublicationCoordination(
			PUBLISHER_DID,
			"gallery",
			FIRST_INTENT,
			1_000,
			FIRST_TOKEN,
			NOW,
		);
		if (!acquired.ok) throw new Error("Expected publication coordination");
		const identity = {
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			intentId: FIRST_INTENT,
			generation: acquired.lease.generation,
			token: acquired.lease.token,
		};

		await expect(
			stub.renewPublicationCoordination({ ...identity, leaseMs: 2_000, now: NOW + 500 }),
		).resolves.toMatchObject({ ok: true, lease: { expiresAt: NOW + 2_500 } });
		await expect(
			stub.releasePublicationCoordination({ ...identity, generation: 99, now: NOW + 501 }),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_COORDINATION_REQUIRED" });
		await expect(
			stub.releasePublicationCoordination({ ...identity, now: NOW + 502 }),
		).resolves.toEqual({ ok: true, replayed: false });
		await expect(
			stub.acquirePublicationCoordination(
				PUBLISHER_DID,
				"gallery",
				SECOND_INTENT,
				1_000,
				SECOND_TOKEN,
				NOW + 503,
			),
		).resolves.toMatchObject({ ok: true });
	});

	it("expires abandoned leases and never persists their bearer token", async () => {
		const stub = publisher();
		const now = Date.now();
		const acquired = await stub.acquirePublicationCoordination(
			PUBLISHER_DID,
			"gallery",
			FIRST_INTENT,
			60_000,
			FIRST_TOKEN,
			now,
		);
		if (!acquired.ok) throw new Error("Expected publication coordination");
		const stored = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ token_hash: string }>(
					"SELECT token_hash FROM publication_coordinations WHERE package_slug = 'gallery'",
				)
				.one(),
		);
		expect(stored.token_hash).not.toBe(FIRST_TOKEN);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE publication_coordinations SET expires_at = ? WHERE package_slug = ?",
				now - 1,
				"gallery",
			);
		});
		await expect(
			stub.renewPublicationCoordination({
				publisherDid: PUBLISHER_DID,
				packageSlug: "gallery",
				intentId: FIRST_INTENT,
				generation: acquired.lease.generation,
				token: FIRST_TOKEN,
				leaseMs: 1_000,
				now,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_COORDINATION_REQUIRED" });

		await runDurableObjectAlarm(stub);
		await expect(
			stub.acquirePublicationCoordination(
				PUBLISHER_DID,
				"gallery",
				SECOND_INTENT,
				1_000,
				SECOND_TOKEN,
			),
		).resolves.toMatchObject({ ok: true, replayed: false });
	});
});
