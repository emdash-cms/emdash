import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { handleStartPublisherArchive } from "../src/backup/workflow-route.js";
import { loadConfiguration } from "../src/config.js";
import { startPublisherArchiveWorkflow } from "../src/workflows/publisher-archive.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const ARCHIVE_ID = "workflow-archive-0001";
const ADMIN: AccessActor = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
};

afterEach(async () => {
	await reset();
});

describe("PublisherArchiveWorkflow", () => {
	it("starts from the Access operator route", async () => {
		const response = await handleStartPublisherArchive(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/archive/start`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "start-publisher-archive-0001",
				},
				body: JSON.stringify({ archiveId: ARCHIVE_ID }),
			}),
			"request-start",
			await loadConfiguration(TEST_BINDINGS),
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
			{
				startWorkflow: async (_workflow, params) => ({
					ok: true,
					workflowId: `${params.archiveId}-workflow`,
					created: true,
				}),
			},
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			data: {
				archiveId: ARCHIVE_ID,
				workflowId: `${ARCHIVE_ID}-workflow`,
				created: true,
			},
		});
	});

	it("restarts an errored deterministic archive instance", async () => {
		const restart = vi.fn(async () => undefined);
		const workflow = {
			create: vi.fn(async () => {
				throw new Error("instance already exists");
			}),
			get: vi.fn(async () => ({
				status: async () => ({ status: "errored" }),
				restart,
			})),
		} as unknown as Parameters<typeof startPublisherArchiveWorkflow>[0];

		await expect(
			startPublisherArchiveWorkflow(workflow, {
				publisherDid: PUBLISHER_DID,
				archiveId: ARCHIVE_ID,
				actorIdentity: "admin@example.com",
			}),
		).resolves.toMatchObject({ ok: true, created: false });
		expect(restart).toHaveBeenCalledOnce();
	});

	it("resumes bounded pages to an encrypted completion manifest", async () => {
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).initializePublisher(PUBLISHER_DID);
		const started = await startPublisherArchiveWorkflow(env.PUBLISHER_ARCHIVE_WORKFLOW, {
			publisherDid: PUBLISHER_DID,
			archiveId: ARCHIVE_ID,
			actorIdentity: "admin@example.com",
		});
		expect(started).toMatchObject({ ok: true, created: true });
		if (!started.ok) return;
		const instance = await env.PUBLISHER_ARCHIVE_WORKFLOW.get(started.workflowId);
		let status = await instance.status();
		for (let attempt = 0; attempt < 100 && status.status !== "complete"; attempt += 1) {
			if (status.status === "errored" || status.status === "terminated") break;
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			status = await instance.status();
		}

		expect(status.status, JSON.stringify(status.error)).toBe("complete");
		expect(status.output).toMatchObject({
			publisherDid: PUBLISHER_DID,
			archiveId: ARCHIVE_ID,
			pages: 4,
		});
		const objects = await env.OPERATIONS_ARCHIVE.list({ prefix: "snapshots/" });
		expect(objects.objects.some((object) => object.key.endsWith("/manifest.json.jwe"))).toBe(true);
	});
});
