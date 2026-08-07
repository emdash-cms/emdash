// Integration tests for the /webhook/github route. Runs in the workers pool
// so SELF.fetch goes through the real Hono handler against a real
// OrchestratorDO instance.
//
// The HMAC verifier checks against env.GITHUB_WEBHOOK_SECRET, which the test
// pool provides via wrangler.test.jsonc / vitest.workers.config.ts. We use
// the same secret to sign synthetic payloads.

import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";

import { verifyWebhookSignature } from "../../.flue/lib/webhook.js";

const SELF = exports.default;

interface TestEnv {
	Orchestrator: Env["Orchestrator"];
	GITHUB_WEBHOOK_SECRET: string;
}

const testEnv = env as unknown as TestEnv;

async function sign(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(testEnv.GITHUB_WEBHOOK_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
	const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256=${hex}`;
}

function uniqueIssueNumber(): number {
	// Random number per test so each lands in a fresh DO instance and doesn't
	// observe state leakage from a prior test in the same file. Using a
	// 24-bit window keeps the numbers human-readable in logs.
	return 1_000_000 + Math.floor(Math.random() * 0xff_ffff);
}

async function postWebhook(opts: {
	eventType: string;
	delivery?: string;
	payload: unknown;
	signOverride?: string;
}): Promise<Response> {
	const body = JSON.stringify(opts.payload);
	const signature = opts.signOverride ?? (await sign(body));
	return SELF.fetch("https://test/webhook/github", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": opts.eventType,
			"x-hub-signature-256": signature,
			...(opts.delivery ? { "x-github-delivery": opts.delivery } : {}),
		},
		body,
	});
}

describe("verifyWebhookSignature (workers-pool)", () => {
	// Lives in the integration suite because `crypto.subtle.timingSafeEqual`
	// is a workerd extension to Web Crypto, not available under Node-pool
	// vitest.
	const SECRET = "test-secret-value";

	test("accepts a valid signature", async () => {
		const body = '{"hello":"world"}';
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
		const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
		expect(await verifyWebhookSignature(SECRET, body, `sha256=${hex}`)).toBe(true);
	});

	test("rejects when the body is tampered after signing", async () => {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("a")));
		const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
		expect(await verifyWebhookSignature(SECRET, "b", `sha256=${hex}`)).toBe(false);
	});

	test("rejects malformed and missing headers without leaking timing", async () => {
		// These never reach timingSafeEqual; they short-circuit on shape.
		expect(await verifyWebhookSignature(SECRET, "x", null)).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", undefined)).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", "")).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", "sha256=")).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", "sha256=ZZZ")).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", "sha256=abc")).toBe(false);
		expect(await verifyWebhookSignature(SECRET, "x", `sha256=${"ab".repeat(30)}`)).toBe(false);
	});
});

describe("POST /webhook/github (workers-pool)", () => {
	test("rejects requests without a valid signature", async () => {
		const res = await postWebhook({
			eventType: "ping",
			payload: {},
			signOverride: "sha256=deadbeef",
		});
		expect(res.status).toBe(401);
	});

	test("ping returns 200 pong", async () => {
		const res = await postWebhook({ eventType: "ping", payload: { zen: "hi" } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("pong");
	});

	test("unhandled event types return 202 skip", async () => {
		const res = await postWebhook({ eventType: "star", payload: {} });
		expect(res.status).toBe(202);
		expect(await res.text()).toMatch(/skipped/);
	});

	test("issue_comment.created with bare verb advances the DO state", async () => {
		const issueNumber = uniqueIssueNumber();
		const res = await postWebhook({
			eventType: "issue_comment",
			delivery: `del-${issueNumber}`,
			payload: {
				action: "created",
				issue: {
					number: issueNumber,
					user: { login: "alice" },
					labels: [{ name: "bot:bug" }, { name: "bot:blocked" }],
				},
				comment: {
					body: "@emdashbot retry",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				sender: { login: "alice" },
			},
		});
		expect(res.status).toBe(202);
		const json = (await res.json()) as { anchor: string; admission: { kind: string } };
		expect(json.anchor).toBe(`issue-${issueNumber}`);
		expect(json.admission.kind).toBe("admitted");

		// Webhook admission is intentionally decoupled from processing. Drive the
		// alarm path explicitly before checking the state transition.
		const stub = testEnv.Orchestrator.getByName(`issue-${issueNumber}`);
		await stub.tick();
		const persisted = await stub.getPersistedState();
		// retry from `blocked` goes to `working` per the machine.
		expect(persisted.state).toBe("working");
	});

	test("classifier failure remains retryable and does not persist state", async () => {
		// The webhook acknowledges durable admission before classifier work. The
		// test entry has no Flue runtime, so processing fails and leaves the item
		// queued for retry without persisting state.
		const issueNumber = uniqueIssueNumber();
		const res = await postWebhook({
			eventType: "issue_comment",
			delivery: `del-${issueNumber}-c`,
			payload: {
				action: "created",
				issue: {
					number: issueNumber,
					user: { login: "alice" },
					labels: [{ name: "bot:bug" }, { name: "bot:blocked" }],
				},
				comment: {
					body: "@emdashbot please try the loader",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				sender: { login: "alice" },
			},
		});
		expect(res.status).toBe(202);

		const stub = testEnv.Orchestrator.getByName(`issue-${issueNumber}`);
		const persisted = await stub.getPersistedState();
		expect(persisted.state).toBe(null);
		expect(await stub.getInboxDepth()).toBe(1);
	});

	test("issue_comment without an @emdashbot mention is skipped", async () => {
		const res = await postWebhook({
			eventType: "issue_comment",
			payload: {
				action: "created",
				issue: { number: 1, user: { login: "alice" } },
				comment: {
					body: "just talking",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				sender: { login: "alice" },
			},
		});
		expect(res.status).toBe(202);
		expect(await res.text()).toMatch(/skipped/);
	});

	test("duplicate delivery is deduped at the DO layer", async () => {
		const issueNumber = uniqueIssueNumber();
		const payload = {
			action: "created",
			issue: {
				number: issueNumber,
				user: { login: "alice" },
				labels: [{ name: "bot:bug" }, { name: "bot:blocked" }],
			},
			comment: {
				body: "@emdashbot retry",
				author_association: "MEMBER",
				user: { login: "alice" },
			},
			sender: { login: "alice" },
		};
		const delivery = `dup-${issueNumber}`;
		const first = await postWebhook({ eventType: "issue_comment", delivery, payload });
		expect(((await first.json()) as { admission: { kind: string } }).admission.kind).toBe(
			"admitted",
		);

		const second = await postWebhook({ eventType: "issue_comment", delivery, payload });
		const secondJson = (await second.json()) as { admission: { kind: string } };
		expect(secondJson.admission.kind).toBe("duplicate");
	});

	test("invalid JSON returns 400", async () => {
		const body = "{this is not json";
		const signature = await sign(body);
		const res = await SELF.fetch("https://test/webhook/github", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "issue_comment",
				"x-hub-signature-256": signature,
			},
			body,
		});
		expect(res.status).toBe(400);
	});
});
