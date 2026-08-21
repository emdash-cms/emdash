// Integration tests for the /webhook/github route. Runs in the workers pool
// so SELF.fetch goes through the real Hono handler against a real
// OrchestratorDO instance.
//
// The HMAC verifier checks against env.GITHUB_WEBHOOK_SECRET, which the test
// pool provides via wrangler.test.jsonc / vitest.workers.config.ts. We use
// the same secret to sign synthetic payloads.

import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";

import { verifyWebhookSignature } from "../../.flue/lib/webhook.js";

const SELF = exports.default;

interface TestEnv {
	Orchestrator: Env["Orchestrator"];
	GITHUB_APP_INSTALLATION_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_OWNER: string;
	GITHUB_REPO: string;
}

const testEnv = env as unknown as TestEnv;

afterEach(() => {
	testEnv.GITHUB_APP_PRIVATE_KEY = "";
	vi.unstubAllGlobals();
});

async function generatedPrivateKeyPem(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	if (!("privateKey" in pair)) throw new Error("RSA key generation did not return a key pair");
	const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	if (!(exported instanceof ArrayBuffer)) throw new Error("RSA private key export was not binary");
	const pkcs8 = new Uint8Array(exported);
	let binary = "";
	for (const byte of pkcs8) binary += String.fromCharCode(byte);
	const body =
		btoa(binary)
			.match(/.{1,64}/g)
			?.join("\n") ?? "";
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

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
	test("serves the public dashboard", async () => {
		const res = await SELF.fetch("https://test/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Issue lifecycle");
		expect(html).toContain("Agent run");
		expect(html).toContain("Work plan");
		expect(html).toContain("Run trace");
	});

	test("dashboard API fails closed when GitHub credentials are unavailable", async () => {
		const res = await SELF.fetch("https://test/api/dashboard");
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "Dashboard data is temporarily unavailable" });
	});

	test("serves the selected issue's public run trace without GitHub credentials", async () => {
		const issueNumber = uniqueIssueNumber();
		const stub = testEnv.Orchestrator.getByName(`issue-${issueNumber}`);
		await stub.debugSetStaleRun(
			"dashboard-trace-run",
			Date.now() - 1_000,
			`investigate-${issueNumber}-dashboard-trace-run`,
			"repro",
		);
		await stub.recordRunTraceEvent({
			runId: "dashboard-trace-run",
			event: {
				key: "dashboard-trace-event",
				at: Date.now(),
				kind: "turn",
				title: "Model turn",
				detail: "deepseek-v4",
				tone: "active",
				output: "Inspecting the issue.",
			},
		});

		const res = await SELF.fetch(`https://test/api/issues/${issueNumber}/trace`);

		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toMatchObject({
			selectedRunId: "dashboard-trace-run",
			events: [{ kind: "turn", output: "Inspecting the issue." }],
		});
	});

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
		// test entry returns a classifier error, so processing leaves the item
		// queued for retry without persisting state or using remote inference.
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

	test("top-level bot PR feedback resolves its head branch before durable admission", async () => {
		const issueNumber = uniqueIssueNumber();
		const pullRequestNumber = uniqueIssueNumber();
		testEnv.GITHUB_APP_PRIVATE_KEY = await generatedPrivateKeyPem();
		const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
		vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push({ url, signal: init?.signal });
			if (url.includes("/access_tokens")) {
				return Promise.resolve(
					new Response(JSON.stringify({ token: "installation-token" }), {
						status: 201,
						headers: { "content-type": "application/json" },
					}),
				);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ head: { ref: `bot/fix-${issueNumber}` } }), {
					headers: { "content-type": "application/json" },
				}),
			);
		});

		const res = await postWebhook({
			eventType: "issue_comment",
			delivery: `pr-comment-${pullRequestNumber}`,
			payload: {
				action: "created",
				issue: {
					number: pullRequestNumber,
					user: { login: "emdashbot[bot]" },
					pull_request: {},
				},
				comment: {
					body: "@emdashbot simplify the adapter test",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				sender: { login: "alice" },
			},
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toMatchObject({ anchor: `issue-${issueNumber}` });
		expect(requests.map((request) => request.url)).toEqual([
			`https://api.github.com/app/installations/${testEnv.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
			`https://api.github.com/repos/${testEnv.GITHUB_OWNER}/${testEnv.GITHUB_REPO}/pulls/${pullRequestNumber}`,
		]);
		expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(requests[1]?.signal).toBe(requests[0]?.signal);
	});

	test("top-level bot PR feedback returns a retryable error when lookup fails", async () => {
		const pullRequestNumber = uniqueIssueNumber();
		testEnv.GITHUB_APP_PRIVATE_KEY = await generatedPrivateKeyPem();
		vi.stubGlobal("fetch", () => Promise.resolve(new Response("unavailable", { status: 503 })));

		const res = await postWebhook({
			eventType: "issue_comment",
			payload: {
				action: "created",
				issue: {
					number: pullRequestNumber,
					user: { login: "emdashbot[bot]" },
					pull_request: {},
				},
				comment: {
					body: "@emdashbot revise this",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				sender: { login: "alice" },
			},
		});

		expect(res.status).toBe(503);
		expect(await res.text()).toBe("pull request lookup failed");
	});

	test("bot PR merge advances the originating issue rather than the PR number", async () => {
		const issueNumber = uniqueIssueNumber();
		const pullRequestNumber = uniqueIssueNumber();
		const res = await postWebhook({
			eventType: "pull_request",
			delivery: `merge-${pullRequestNumber}`,
			payload: {
				action: "closed",
				pull_request: {
					number: pullRequestNumber,
					user: { login: "emdashbot[bot]" },
					head: { ref: `bot/fix-${issueNumber}` },
					merged: true,
					labels: [{ name: "bot:bug" }, { name: "bot:in-review" }],
				},
				sender: { login: "alice" },
			},
		});

		expect(res.status).toBe(202);
		expect(await res.json()).toMatchObject({ anchor: `issue-${issueNumber}` });
		const issueStub = testEnv.Orchestrator.getByName(`issue-${issueNumber}`);
		await issueStub.tick();
		expect((await issueStub.getPersistedState()).state).toBe("done");
		expect(
			(await testEnv.Orchestrator.getByName(`issue-${pullRequestNumber}`).getPersistedState())
				.state,
		).toBe(null);
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

	test("issues.closed drives the branch-cleanup path", async () => {
		const issueNumber = uniqueIssueNumber();
		const res = await postWebhook({
			eventType: "issues",
			delivery: `close-${issueNumber}`,
			payload: {
				action: "closed",
				issue: { number: issueNumber, user: { login: "alice" } },
				sender: { login: "alice" },
			},
		});
		expect(res.status).toBe(202);
		const json = (await res.json()) as { anchor: string; cleanup: { kind: string } };
		expect(json.anchor).toBe(`issue-${issueNumber}`);
		// No live private key in the test pool, so the reap no-ops but the path runs.
		expect(json.cleanup.kind).toBe("skipped");
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
