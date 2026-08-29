import { is } from "@atcute/lexicons/validations";
import { LabelerGetPolicy, NSID } from "@emdash-cms/registry-lexicons";
import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { dispatchAssessmentRuns } from "../src/assessment/dispatch.js";
import type { AssessmentWorkflowParams } from "../src/assessment/types.js";

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("labeler scaffold", () => {
	it("boots with the configured local bindings", async () => {
		expect(env.DB).toBeDefined();
		expect(env.AI).toBeDefined();
		expect(env.ASSESSMENT_WORKFLOW).toBeDefined();
		expect(await env.LABEL_SUBSCRIPTION_DO.getByName("test").status()).toEqual({ ready: true });
		expect(await env.LABELER_DISCOVERY_DO.getByName("test").status()).toEqual({
			configured: true,
			running: false,
			ready: false,
			cursor: null,
			consecutiveFailures: 0,
			reason: "awaiting-start",
		});
	});

	it("applies the initial D1 migration", async () => {
		const table = await env.DB.prepare(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
		)
			.bind("service_state")
			.first<{ name: string }>();

		expect(table?.name).toBe("service_state");
	});

	it("exposes the public health route", async () => {
		const response = await SELF.fetch("https://labeler.test/health");
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			service: "emdash-labeler",
			status: "not-ready",
			discovery: { ready: false, reason: "awaiting-start" },
			signing: { ready: true },
		});

		const missing = await SELF.fetch("https://labeler.test/missing");
		expect(missing.status).toBe(404);
	});

	it("publishes the did:web signing method and manual-only policy", async () => {
		const did = await SELF.fetch("https://labeler.test/.well-known/did.json");
		expect(did.status).toBe(200);
		expect(await did.json()).toMatchObject({
			id: "did:web:labels.emdashcms.com",
			verificationMethod: [
				expect.objectContaining({
					id: "did:web:labels.emdashcms.com#atproto_label",
				}),
			],
		});
		const policy = await SELF.fetch("https://labeler.test/.well-known/emdash-labeler-policy.json");
		expect(await policy.json()).toMatchObject({
			labelerDid: "did:web:labels.emdashcms.com",
			autoPass: "disabled",
			subjectCollections: [
				"com.emdashcms.experimental.package.profile",
				"com.emdashcms.experimental.package.release",
			],
		});
	});

	it("routes the public label query and subscription endpoints", async () => {
		const query = await SELF.fetch("https://labeler.test/xrpc/com.atproto.label.queryLabels");
		expect(query.status).toBe(400);
		expect(await query.json()).toMatchObject({ error: "InvalidRequest" });

		const subscribe = await SELF.fetch(
			"https://labeler.test/xrpc/com.atproto.label.subscribeLabels",
		);
		expect(subscribe.status).toBe(426);
	});

	it("routes the public assessment policy query", async () => {
		const response = await SELF.fetch(`https://labeler.test/xrpc/${NSID.labelerGetPolicy}`);
		expect(response.status).toBe(200);
		expect(is(LabelerGetPolicy.mainSchema.output.schema, await response.json())).toBe(true);

		const mutation = await SELF.fetch(`https://labeler.test/xrpc/${NSID.labelerGetPolicy}`, {
			method: "POST",
		});
		expect(mutation.status).toBe(405);
		expect(mutation.headers.get("allow")).toBe("GET");
	});

	it("fails closed at the Access JWT boundary", async () => {
		const missingAssertion = await SELF.fetch("https://labeler.test/_admin");
		expect(missingAssertion.status).toBe(401);
		expect(missingAssertion.headers.get("cache-control")).toBe("no-store");

		const directShell = await SELF.fetch("https://labeler.test/index.html");
		expect(directShell.status).toBe(404);
		const rootShell = await SELF.fetch("https://labeler.test/");
		expect(rootShell.status).toBe(404);
	});

	it("uses run keys as deterministic Workflow instance IDs", async () => {
		const run: AssessmentWorkflowParams = {
			runKey: "profile-test-policy-v1",
			subjectUri: "at://did:plc:test/com.emdashcms.experimental.package.profile/self",
			subjectCid: "bafytest",
			subjectKind: "profile",
		};
		const batches: Array<Array<{ id: string; params: AssessmentWorkflowParams }>> = [];
		const workflow = {
			async createBatch(batch: Array<{ id: string; params: AssessmentWorkflowParams }>) {
				batches.push(batch);
				return [];
			},
		};

		for (let attempt = 0; attempt < 2; attempt++) {
			expect(await dispatchAssessmentRuns(workflow, [run])).toEqual({
				acceptedRunKeys: [run.runKey],
			});
		}
		expect(batches).toEqual([[{ id: run.runKey, params: run }], [{ id: run.runKey, params: run }]]);
	});
});
