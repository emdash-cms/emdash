import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { loadConfiguration } from "../src/config.js";
import { encodeDirectoryCursor, handleListDirectory } from "../src/directory/routes.js";
import { identityDirectoryShard, registerDirectoryIdentity } from "../src/directory/sharding.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const SECOND_PUBLISHER_DID = "did:plc:second-publisher";
const APPROVER_DID = "did:plc:approver";
const VIEWER: AccessActor = {
	realm: "access",
	identity: "viewer@example.com",
	email: "viewer@example.com",
	role: "viewer",
};

afterEach(async () => {
	await reset();
});

describe("IdentityDirectoryDurableObject", () => {
	it("routes identities to deterministic shards and lists each kind independently", async () => {
		const publisherShard = await identityDirectoryShard(PUBLISHER_DID);
		expect(publisherShard).toMatch(/^[0-9a-f]{2}$/);
		await expect(registerDirectoryIdentity("publisher", PUBLISHER_DID, 100)).resolves.toMatchObject(
			{
				created: true,
				shard: publisherShard,
			},
		);
		await expect(registerDirectoryIdentity("publisher", PUBLISHER_DID, 200)).resolves.toMatchObject(
			{
				created: false,
				shard: publisherShard,
			},
		);
		await registerDirectoryIdentity("publisher", SECOND_PUBLISHER_DID, 150);
		await registerDirectoryIdentity("approver", APPROVER_DID, 175);

		const publisher = env.IDENTITY_DIRECTORY_DO.getByName(publisherShard);
		await expect(publisher.list("publisher", null, 10)).resolves.toEqual([
			{
				kind: "publisher",
				did: PUBLISHER_DID,
				registeredAt: 100,
				lastSeenAt: 200,
			},
		]);
		await expect(publisher.list("approver", null, 10)).resolves.toEqual([]);
	});

	it("rejects a DID routed to a different shard", async () => {
		const expected = await identityDirectoryShard(PUBLISHER_DID);
		const wrong = expected === "00" ? "01" : "00";
		const stub = env.IDENTITY_DIRECTORY_DO.getByName(wrong);
		await runInDurableObject(stub, async (instance) => {
			await expect(instance.register("publisher", PUBLISHER_DID, 100)).rejects.toMatchObject({
				code: "DIRECTORY_SHARD_MISMATCH",
			});
		});
	});

	it("lists one bounded directory shard through Access", async () => {
		const shard = await identityDirectoryShard(PUBLISHER_DID);
		await registerDirectoryIdentity("publisher", PUBLISHER_DID, 100);
		const cursor = encodeDirectoryCursor({ shard: Number.parseInt(shard, 16), afterDid: null });
		const response = await handleListDirectory(
			new Request(
				`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/directory?kind=publisher&limit=10&cursor=${encodeURIComponent(cursor)}`,
			),
			"request-directory",
			await loadConfiguration(TEST_BINDINGS),
			{},
			VIEWER,
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: {
				items: [{ did: PUBLISHER_DID, kind: "publisher", shard }],
			},
		});
	});
});
