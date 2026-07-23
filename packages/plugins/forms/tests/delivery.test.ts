import type {
	PluginContext,
	QueryOptions,
	RouteContext,
	StorageCollection,
	WhereValue,
} from "emdash";
import { describe, expect, it, vi } from "vitest";

import { handleCleanup } from "../src/handlers/cron.js";
import { deliveryHealthHandler, receiptStatusHandler } from "../src/handlers/delivery.js";
import { submitHandler } from "../src/handlers/submit.js";
import { createPlugin } from "../src/index.js";
import {
	DELIVERY_CRON_NAME,
	DELIVERY_CRON_SCHEDULE,
	DELIVERY_HEARTBEAT_KEY,
} from "../src/outbox.js";
import { handleDelivery } from "../src/outbox.js";
import type { SubmitInput } from "../src/schemas.js";
import type { DeliveryHeartbeat, FormDefinition, Submission } from "../src/types.js";

class TestCollection<T> implements StorageCollection<T> {
	readonly records = new Map<string, T>();
	failNextQuery: Error | null = null;

	async get(id: string): Promise<T | null> {
		return this.records.get(id) ?? null;
	}

	async put(id: string, data: T): Promise<void> {
		this.records.set(id, structuredClone(data));
	}

	async delete(id: string): Promise<boolean> {
		return this.records.delete(id);
	}

	async exists(id: string): Promise<boolean> {
		return this.records.has(id);
	}

	async getMany(ids: string[]): Promise<Map<string, T>> {
		return new Map(
			ids.flatMap((id) => (this.records.has(id) ? [[id, this.records.get(id)!]] : [])),
		);
	}

	async putMany(items: Array<{ id: string; data: T }>): Promise<void> {
		for (const item of items) await this.put(item.id, item.data);
	}

	async deleteMany(ids: string[]): Promise<number> {
		let deleted = 0;
		for (const id of ids) {
			if (this.records.delete(id)) deleted++;
		}
		return deleted;
	}

	async query(options: QueryOptions = {}) {
		if (this.failNextQuery) {
			const error = this.failNextQuery;
			this.failNextQuery = null;
			throw error;
		}
		let items = Array.from(this.records, ([id, data]) => ({ id, data }));
		if (options.where) {
			items = items.filter(({ data }) =>
				Object.entries(options.where!).every(([field, expected]) =>
					matches((data as Record<string, unknown>)[field], expected),
				),
			);
		}
		if (options.orderBy) {
			for (const [field, direction] of Object.entries(options.orderBy).toReversed()) {
				items = items.toSorted((left, right) => {
					const a = (left.data as Record<string, unknown>)[field];
					const b = (right.data as Record<string, unknown>)[field];
					return String(a).localeCompare(String(b)) * (direction === "asc" ? 1 : -1);
				});
			}
		}
		const limit = options.limit ?? 50;
		return { items: items.slice(0, limit), hasMore: items.length > limit };
	}

	async count(where?: Record<string, WhereValue>): Promise<number> {
		return (await this.query({ where, limit: 1000 })).items.length;
	}
}

class TestKv {
	readonly records = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.records.get(key) as T | undefined) ?? null;
	}

	async set(key: string, value: unknown): Promise<void> {
		this.records.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<boolean> {
		return this.records.delete(key);
	}

	async list(prefix = "") {
		return [...this.records]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, value]) => ({ key, value }));
	}
}

function matches(actual: unknown, expected: WhereValue): boolean {
	if (typeof expected !== "object" || expected === null) return actual === expected;
	if ("in" in expected) return expected.in.includes(actual as string | number);
	if ("startsWith" in expected) {
		return typeof actual === "string" && actual.startsWith(expected.startsWith);
	}
	if (typeof actual !== "string" && typeof actual !== "number") return false;
	if (expected.gt !== undefined && !(actual > expected.gt)) return false;
	if (expected.gte !== undefined && !(actual >= expected.gte)) return false;
	if (expected.lt !== undefined && !(actual < expected.lt)) return false;
	if (expected.lte !== undefined && !(actual <= expected.lte)) return false;
	return true;
}

function makeForm(overrides: Partial<FormDefinition["settings"]> = {}): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		pages: [
			{
				fields: [
					{
						id: "email",
						type: "email",
						label: "Email",
						name: "email",
						required: true,
						width: "full",
					},
				],
			},
		],
		settings: {
			confirmationMessage: "Thanks",
			notifyEmails: ["owner@example.com"],
			digestEnabled: false,
			digestHour: 9,
			autoresponder: { subject: "We got it", body: "Thank you" },
			webhookUrl: "https://hooks.example.com/forms",
			retentionDays: 0,
			spamProtection: "none",
			submitLabel: "Send",
			...overrides,
		},
		status: "active",
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function createHarness(form = makeForm()) {
	const forms = new TestCollection<FormDefinition>();
	const submissions = new TestCollection<Submission>();
	const kv = new TestKv();
	forms.records.set("form-1", form);
	const send = vi.fn(async () => {});
	const fetch = vi.fn(async () => new Response(null, { status: 204 }));
	const log = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	const cronTasks = new Map<
		string,
		{ name: string; schedule: string; nextRunAt: string; lastRunAt: string | null }
	>();
	const schedule = vi.fn(async (name: string, options: { schedule: string }) => {
		cronTasks.set(name, {
			name,
			schedule: options.schedule,
			nextRunAt: "2090-01-01T00:01:00.000Z",
			lastRunAt: null,
		});
	});
	const cron = {
		schedule,
		cancel: vi.fn(async (name: string) => {
			cronTasks.delete(name);
		}),
		list: vi.fn(async () => [...cronTasks.values()]),
	};
	const shared = {
		storage: { forms, submissions },
		kv,
		email: { send },
		http: { fetch },
		cron,
		log,
		site: { url: "https://example.com" },
	};
	const route = {
		...shared,
		input: { formId: "form-1", data: { email: "person@example.com" } },
		requestMeta: {
			ip: "203.0.113.1",
			userAgent: "test",
			referer: "https://example.com/contact",
		},
	} as unknown as RouteContext<SubmitInput>;

	return {
		forms,
		submissions,
		kv,
		send,
		fetch,
		cron,
		cronTasks,
		log,
		route,
		plugin: shared as unknown as PluginContext,
	};
}

async function onlySubmission(collection: TestCollection<Submission>) {
	expect(collection.records.size).toBe(1);
	return [...collection.records.entries()][0]!;
}

describe("forms submission outbox", () => {
	it("persists a correlated delivery plan and returns both identifiers without request-time delivery", async () => {
		const harness = createHarness();

		const response = await submitHandler(harness.route);
		const [submissionId, submission] = await onlySubmission(harness.submissions);

		expect(response).toMatchObject({
			success: true,
			submissionId,
			receiptId: submission.delivery?.receiptId,
		});
		expect(submission.delivery).toMatchObject({
			version: 1,
			destinations: [
				{ type: "notification-email", status: "pending" },
				{ type: "autoresponder-email", status: "pending" },
				{ type: "webhook", status: "pending" },
			],
		});
		expect(submission.deliveryStatus).toBe("pending");
		expect(submission.deliveryNextAttemptAt).toBe(submission.createdAt);
		expect(submission.delivery?.destinations[0]).toMatchObject({
			createdAt: submission.createdAt,
			updatedAt: submission.createdAt,
			nextAttemptAt: submission.createdAt,
			claimedAt: null,
			sideEffectStartedAt: null,
			attemptedAt: null,
			deliveredAt: null,
			terminalAt: null,
		});
		expect(harness.send).not.toHaveBeenCalled();
		expect(harness.fetch).not.toHaveBeenCalled();
	});

	it("delivers synchronously from the persisted outbox when cron is unavailable", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined }));
		harness.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		delete (harness.route as unknown as { cron?: unknown }).cron;
		delete (harness.plugin as unknown as { cron?: unknown }).cron;

		const response = await submitHandler(harness.route);
		const [submissionId, persisted] = await onlySubmission(harness.submissions);
		const submission = await harness.submissions.get(submissionId);

		expect(response).toMatchObject({
			success: true,
			receiptId: persisted.receiptId,
		});
		expect(submission?.deliveryStatus).toBe("terminal");
		expect(submission?.delivery?.destinations).toMatchObject([
			{ type: "notification-email", status: "delivered" },
			{ type: "webhook", status: "terminal", attempts: 1 },
		]);
		expect(harness.send).toHaveBeenCalledTimes(1);
		expect(harness.fetch).toHaveBeenCalledTimes(1);
	});

	it("limits the no-cron fallback to the submission created by that request", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined }));
		await submitHandler(harness.route);
		const [firstSubmissionId] = await onlySubmission(harness.submissions);
		harness.send.mockClear();
		harness.fetch.mockClear();
		delete (harness.route as unknown as { cron?: unknown }).cron;
		delete (harness.plugin as unknown as { cron?: unknown }).cron;
		harness.route.input.data.email = "second@example.com";

		const response = await submitHandler(harness.route);
		if (!("receiptId" in response)) throw new Error("Expected a successful submission");
		const first = await harness.submissions.get(firstSubmissionId);
		const second = [...harness.submissions.records.values()].find(
			(submission) => submission.receiptId === response.receiptId,
		);

		expect(first?.deliveryStatus).toBe("pending");
		expect(second?.deliveryStatus).toBe("delivered");
		expect(harness.send).toHaveBeenCalledTimes(1);
		expect(harness.fetch).toHaveBeenCalledTimes(1);
	});

	it("self-heals an upgraded active plugin before acceptance without rescheduling every submit", async () => {
		const harness = createHarness();

		await submitHandler(harness.route);
		harness.route.input.data.email = "second@example.com";
		await submitHandler(harness.route);

		expect(harness.cron.schedule).toHaveBeenCalledTimes(1);
		expect(harness.cron.schedule).toHaveBeenCalledWith(DELIVERY_CRON_NAME, {
			schedule: DELIVERY_CRON_SCHEDULE,
		});
		expect(harness.submissions.records.size).toBe(2);
	});

	it("does not persist a submission when the upgrade cron cannot be scheduled", async () => {
		const harness = createHarness();
		harness.cron.schedule.mockRejectedValueOnce(new Error("scheduler unavailable"));

		await expect(submitHandler(harness.route)).rejects.toMatchObject({
			code: "INTERNAL_ERROR",
			message: "Form delivery is temporarily unavailable",
		});
		expect(harness.submissions.records.size).toBe(0);
		expect(harness.send).not.toHaveBeenCalled();
		expect(harness.fetch).not.toHaveBeenCalled();
	});

	it("silently accepts honeypot submissions without storing or delivering them", async () => {
		const harness = createHarness(makeForm({ spamProtection: "honeypot" }));
		harness.route.input.data._hp = "filled";

		const response = await submitHandler(harness.route);

		expect(response).toMatchObject({
			success: true,
			submissionId: expect.any(String),
			receiptId: expect.any(String),
		});
		expect(harness.submissions.records.size).toBe(0);
		expect(harness.send).not.toHaveBeenCalled();
		expect(harness.fetch).not.toHaveBeenCalled();
	});

	it("keeps successful destinations complete while retrying a partial failure", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined }));
		harness.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await submitHandler(harness.route);
		const [submissionId] = await onlySubmission(harness.submissions);

		await handleDelivery(harness.plugin, { now: new Date("2090-01-01T00:00:00.000Z") });
		let submission = await harness.submissions.get(submissionId);
		expect(submission?.delivery?.destinations).toMatchObject([
			{ type: "notification-email", status: "delivered", attempts: 1 },
			{ type: "webhook", status: "retrying", attempts: 1 },
		]);
		expect(harness.send).toHaveBeenCalledTimes(1);
		expect(harness.fetch).toHaveBeenCalledTimes(1);

		await handleDelivery(harness.plugin, { now: new Date("2090-01-01T00:02:00.000Z") });
		submission = await harness.submissions.get(submissionId);
		expect(submission?.deliveryStatus).toBe("delivered");
		expect(submission?.delivery?.destinations).toMatchObject([
			{ status: "delivered", attempts: 1 },
			{ status: "delivered", attempts: 2 },
		]);
		expect(harness.send).toHaveBeenCalledTimes(1);
		expect(harness.fetch).toHaveBeenCalledTimes(2);

		const webhookInit = harness.fetch.mock.calls[1]![1]!;
		expect(webhookInit.headers).toMatchObject({
			"Idempotency-Key": expect.stringContaining(":webhook"),
			"X-EmDash-Submission-Id": submissionId,
			"X-EmDash-Receipt-Id": submission?.delivery?.receiptId,
		});
	});

	it("uses exponential retries, bounds errors, and stops permanently after five attempts", async () => {
		const harness = createHarness({
			...makeForm({ notifyEmails: [], autoresponder: undefined }),
		});
		harness.fetch.mockRejectedValue(new Error("x".repeat(800)));
		await submitHandler(harness.route);
		const [submissionId] = await onlySubmission(harness.submissions);

		const attempts = [
			"2090-01-01T00:00:00.000Z",
			"2090-01-01T00:01:00.000Z",
			"2090-01-01T00:03:00.000Z",
			"2090-01-01T00:07:00.000Z",
			"2090-01-01T00:15:00.000Z",
		];
		const retryTimes = attempts.slice(1);
		for (const [index, now] of attempts.entries()) {
			await handleDelivery(harness.plugin, { now: new Date(now) });
			const current = await harness.submissions.get(submissionId);
			if (index < retryTimes.length) {
				expect(current?.delivery?.destinations[0]?.nextAttemptAt).toBe(retryTimes[index]);
			}
		}

		const submission = await harness.submissions.get(submissionId);
		const destination = submission?.delivery?.destinations[0];
		expect(destination).toMatchObject({
			status: "terminal",
			attempts: 5,
			nextAttemptAt: null,
			terminalAt: attempts.at(-1),
		});
		expect(destination?.lastError).toHaveLength(500);
		expect(submission?.deliveryStatus).toBe("terminal");
		expect(submission?.deliveryNextAttemptAt).toBeNull();
		expect(harness.fetch).toHaveBeenCalledTimes(5);

		await handleDelivery(harness.plugin, { now: new Date("2091-01-01T00:00:00.000Z") });
		expect(harness.fetch).toHaveBeenCalledTimes(5);
	});

	it("does not redeliver a completed outbox on later cron runs", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined }));
		await submitHandler(harness.route);

		await handleDelivery(harness.plugin, { now: new Date("2090-01-01T00:00:00.000Z") });
		await handleDelivery(harness.plugin, { now: new Date("2090-01-02T00:00:00.000Z") });

		expect(harness.send).toHaveBeenCalledTimes(1);
		expect(harness.fetch).toHaveBeenCalledTimes(1);
	});

	it("delivers outbox rows created before dispatch idempotency fields existed", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined }));
		await submitHandler(harness.route);
		const [submissionId, submission] = await onlySubmission(harness.submissions);
		for (const destination of submission.delivery!.destinations) {
			delete destination.idempotencyKey;
			delete destination.sideEffectStartedAt;
		}
		await harness.submissions.put(submissionId, submission);

		await handleDelivery(harness.plugin, {
			now: new Date("2090-01-01T00:00:00.000Z"),
		});
		const delivered = await harness.submissions.get(submissionId);

		expect(delivered?.deliveryStatus).toBe("delivered");
		expect(harness.fetch.mock.calls[0]![1]!.headers).toMatchObject({
			"Idempotency-Key": expect.stringContaining(":webhook"),
		});
	});

	it("serializes concurrent processor calls so an email side effect runs once", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined, webhookUrl: undefined }));
		let releaseSend!: () => void;
		harness.send.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseSend = resolve;
				}),
		);
		await submitHandler(harness.route);

		const first = handleDelivery(harness.plugin, {
			now: new Date("2090-01-01T00:00:00.000Z"),
		});
		const second = handleDelivery(harness.plugin, {
			now: new Date("2090-01-01T00:00:00.000Z"),
		});
		await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
		releaseSend();
		await Promise.all([first, second]);

		expect(harness.send).toHaveBeenCalledTimes(1);
	});

	it("terminalizes an expired email lease after dispatch began instead of duplicating it", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined, webhookUrl: undefined }));
		await submitHandler(harness.route);
		const [submissionId, submission] = await onlySubmission(harness.submissions);
		const destination = submission.delivery!.destinations[0]!;
		submission.delivery!.destinations[0] = {
			...destination,
			status: "processing",
			attempts: 1,
			claimedAt: "2090-01-01T00:00:00.000Z",
			claimToken: "abandoned",
			sideEffectStartedAt: "2090-01-01T00:00:01.000Z",
			attemptedAt: "2090-01-01T00:00:00.000Z",
			nextAttemptAt: "2090-01-01T00:05:00.000Z",
		};
		submission.deliveryStatus = "processing";
		submission.deliveryNextAttemptAt = "2090-01-01T00:05:00.000Z";
		await harness.submissions.put(submissionId, submission);

		await handleDelivery(harness.plugin, {
			now: new Date("2090-01-01T00:06:00.000Z"),
		});
		const finished = await harness.submissions.get(submissionId);

		expect(finished?.delivery?.destinations[0]).toMatchObject({
			status: "terminal",
			attempts: 1,
			terminalAt: "2090-01-01T00:06:00.000Z",
			lastError: expect.stringContaining("outcome is unknown"),
		});
		expect(finished?.deliveryStatus).toBe("terminal");
		expect(harness.send).not.toHaveBeenCalled();
	});

	it("does not retry an ambiguous email provider failure", async () => {
		const harness = createHarness(makeForm({ autoresponder: undefined, webhookUrl: undefined }));
		harness.send.mockRejectedValueOnce(new Error("provider timeout"));
		await submitHandler(harness.route);
		const [submissionId] = await onlySubmission(harness.submissions);

		await handleDelivery(harness.plugin, {
			now: new Date("2090-01-01T00:00:00.000Z"),
		});
		await handleDelivery(harness.plugin, {
			now: new Date("2091-01-01T00:00:00.000Z"),
		});
		const submission = await harness.submissions.get(submissionId);

		expect(submission?.delivery?.destinations[0]).toMatchObject({
			status: "terminal",
			attempts: 1,
			sideEffectStartedAt: "2090-01-01T00:00:00.000Z",
			lastError: expect.stringContaining("outcome is unknown"),
		});
		expect(harness.send).toHaveBeenCalledTimes(1);
	});

	it("timestamps a long-running attempt and retry from the actual operation times", async () => {
		const harness = createHarness({
			...makeForm({ notifyEmails: [], autoresponder: undefined }),
		});
		harness.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await submitHandler(harness.route);
		const [submissionId] = await onlySubmission(harness.submissions);
		const times = [
			"2090-01-01T00:00:00.000Z",
			"2090-01-01T00:00:01.000Z",
			"2090-01-01T00:04:00.000Z",
			"2090-01-01T00:04:01.000Z",
		].map((value) => new Date(value));
		const clock = () => times.shift() ?? new Date("2090-01-01T00:04:01.000Z");

		await handleDelivery(harness.plugin, { clock });
		const submission = await harness.submissions.get(submissionId);

		expect(submission?.delivery?.destinations[0]).toMatchObject({
			status: "retrying",
			attemptedAt: "2090-01-01T00:00:01.000Z",
			updatedAt: "2090-01-01T00:04:00.000Z",
			nextAttemptAt: "2090-01-01T00:05:00.000Z",
		});
	});
});

describe("public delivery status", () => {
	it("returns a correlated status projection without payloads or destination PII", async () => {
		const harness = createHarness();
		const submitted = await submitHandler(harness.route);
		if (!("receiptId" in submitted)) throw new Error("Expected a successful submission");

		const status = await receiptStatusHandler({
			...harness.route,
			input: { receiptId: submitted.receiptId },
		} as unknown as RouteContext<{ receiptId: string }>);
		const serialized = JSON.stringify(status);

		expect(status).toMatchObject({
			receiptId: submitted.receiptId,
			status: "pending",
			attempts: 0,
			destinations: [
				{ type: "notification-email", status: "pending", attempts: 0 },
				{ type: "autoresponder-email", status: "pending", attempts: 0 },
				{ type: "webhook", status: "pending", attempts: 0 },
			],
		});
		expect(serialized).not.toContain("owner@example.com");
		expect(serialized).not.toContain("person@example.com");
		expect(serialized).not.toContain("hooks.example.com");
		expect(serialized).not.toContain("Thank you");
		expect(serialized).not.toContain('"body"');
		expect(serialized).not.toContain('"url"');
		expect(serialized).not.toContain('"to"');
	});

	it("returns not found for an unknown receipt", async () => {
		const harness = createHarness();

		await expect(
			receiptStatusHandler({
				...harness.route,
				input: { receiptId: "missing" },
			} as unknown as RouteContext<{ receiptId: string }>),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("public delivery health", () => {
	it("reports missing, fresh, and stale heartbeats with sanitized aggregate outbox counts", async () => {
		const harness = createHarness();
		await submitHandler(harness.route);
		const [, dueSubmission] = await onlySubmission(harness.submissions);
		harness.submissions.records.set("terminal", {
			...structuredClone(dueSubmission),
			receiptId: "terminal-receipt",
			deliveryStatus: "terminal",
			deliveryNextAttemptAt: null,
		});
		const now = new Date("2090-01-01T00:00:00.000Z");

		let health = await deliveryHealthHandler(harness.route, now);
		expect(health).toEqual({
			heartbeatStatus: "missing",
			dueCount: 1,
			terminalCount: 1,
			oldestDueAt: dueSubmission.deliveryNextAttemptAt,
			lastRunAt: null,
			lastSuccessAt: null,
			lastError: null,
		});

		await handleDelivery(harness.plugin, { now });
		health = await deliveryHealthHandler(harness.route, new Date("2090-01-01T00:01:00.000Z"));
		expect(health).toMatchObject({
			heartbeatStatus: "fresh",
			lastRunAt: now.toISOString(),
			lastSuccessAt: now.toISOString(),
			lastError: null,
		});

		health = await deliveryHealthHandler(harness.route, new Date("2090-01-01T00:04:00.001Z"));
		expect(health.heartbeatStatus).toBe("stale");
	});

	it("records processor failure while exposing only a bounded safe public error", async () => {
		const harness = createHarness();
		harness.submissions.failNextQuery = new Error(
			"https://secret.example/hook owner@example.com " + "x".repeat(800),
		);
		const now = new Date("2090-01-01T00:00:00.000Z");

		await expect(handleDelivery(harness.plugin, { now })).rejects.toThrow();
		const heartbeat = await harness.kv.get<DeliveryHeartbeat>(DELIVERY_HEARTBEAT_KEY);
		expect(heartbeat).toMatchObject({
			version: 1,
			status: "failure",
			completedAt: now.toISOString(),
			lastSuccessAt: null,
		});
		expect(heartbeat?.error?.length).toBeLessThanOrEqual(500);

		const health = await deliveryHealthHandler(harness.route, now);
		const serialized = JSON.stringify(health);
		expect(health).toMatchObject({
			heartbeatStatus: "failing",
			lastRunAt: now.toISOString(),
			lastError: "Delivery processor failed",
		});
		expect(serialized).not.toContain("secret.example");
		expect(serialized).not.toContain("owner@example.com");
	});

	it("registers both public delivery routes as no-store", () => {
		const plugin = createPlugin() as unknown as {
			routes: Record<string, { public?: boolean; cacheControl?: string }>;
		};

		expect(plugin.routes["delivery/receipt"]).toMatchObject({
			public: true,
			cacheControl: "no-store",
		});
		expect(plugin.routes["delivery/health"]).toMatchObject({
			public: true,
			cacheControl: "no-store",
		});
	});
});

describe("submission retention", () => {
	it("deletes expired submissions while retaining fresh ones", async () => {
		const form = makeForm({ retentionDays: 7 });
		const harness = createHarness(form);
		harness.submissions.records.set("expired", {
			formId: "form-1",
			data: {},
			status: "new",
			starred: false,
			createdAt: "2000-01-01T00:00:00.000Z",
			meta: { ip: null, userAgent: null, referer: null, country: null },
		});
		harness.submissions.records.set("fresh", {
			formId: "form-1",
			data: {},
			status: "new",
			starred: false,
			createdAt: new Date().toISOString(),
			meta: { ip: null, userAgent: null, referer: null, country: null },
		});

		await handleCleanup(harness.plugin);

		expect(harness.submissions.records.has("expired")).toBe(false);
		expect(harness.submissions.records.has("fresh")).toBe(true);
		expect((await harness.forms.get("form-1"))?.submissionCount).toBe(1);
	});

	it("retains active delivery work and recent terminal receipts while deleting delivered work", async () => {
		const form = makeForm({ retentionDays: 7, autoresponder: undefined });
		const harness = createHarness(form);
		await submitHandler(harness.route);
		const [submissionId, pending] = await onlySubmission(harness.submissions);
		const oldTimestamp = "2000-01-01T00:00:00.000Z";
		const pendingDestination = pending.delivery!.destinations[0]!;
		pending.createdAt = oldTimestamp;
		pending.delivery!.destinations[0] = {
			...pendingDestination,
			createdAt: oldTimestamp,
			updatedAt: oldTimestamp,
			nextAttemptAt: oldTimestamp,
		};
		pending.deliveryNextAttemptAt = oldTimestamp;
		await harness.submissions.put(submissionId, pending);

		const terminal = structuredClone(pending);
		const recentTerminalAt = new Date().toISOString();
		terminal.receiptId = "terminal-receipt";
		terminal.delivery!.receiptId = "terminal-receipt";
		terminal.delivery!.destinations = terminal.delivery!.destinations.map((destination) => ({
			...destination,
			status: "terminal",
			nextAttemptAt: null,
			terminalAt: recentTerminalAt,
		}));
		terminal.deliveryStatus = "terminal";
		terminal.deliveryNextAttemptAt = null;
		await harness.submissions.put("terminal", terminal);

		const delivered = structuredClone(pending);
		delivered.receiptId = "delivered-receipt";
		delivered.delivery!.receiptId = "delivered-receipt";
		delivered.delivery!.destinations = delivered.delivery!.destinations.map((destination) => ({
			...destination,
			status: "delivered",
			nextAttemptAt: null,
			deliveredAt: oldTimestamp,
		}));
		delivered.deliveryStatus = "delivered";
		delivered.deliveryNextAttemptAt = null;
		await harness.submissions.put("delivered", delivered);

		await handleCleanup(harness.plugin);

		expect(harness.submissions.records.has(submissionId)).toBe(true);
		expect(harness.submissions.records.has("terminal")).toBe(true);
		expect(harness.submissions.records.has("delivered")).toBe(false);
	});
});
