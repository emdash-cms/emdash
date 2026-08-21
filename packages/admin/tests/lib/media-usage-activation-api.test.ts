import { afterEach, describe, expect, it, vi } from "vitest";

import {
	MediaUsageActivationRequestError,
	advanceMediaUsageActivation,
	fetchMediaUsageActivationStatus,
	fetchMediaUsageProgress,
} from "../../src/lib/api/media-usage-activation.js";

const activationUrl = "/_emdash/api/admin/media-usage/activation";
const progressUrl = "/_emdash/api/admin/media-usage/progress";

function activationStatus(state: "expanded" | "activating" | "active" = "expanded") {
	return {
		state,
		collectionCursor: state === "activating" ? "posts" : null,
		attemptCount: state === "expanded" ? 0 : 1,
		drainConfirmedAt: state === "expanded" ? null : "2026-08-16T09:00:00.000Z",
		lastAttemptedAt: state === "expanded" ? null : "2026-08-16T09:00:00.000Z",
		lastErrorCode: null,
		leaseExpiresAt: null,
		activatedAt: state === "active" ? "2026-08-16T09:00:01.000Z" : null,
		updatedAt: "2026-08-16T09:00:01.000Z",
	} as const;
}

function success(data: unknown): Response {
	return Response.json({ success: true, data });
}

function failure(status: number, code: string, details?: unknown): Response {
	return Response.json(
		{
			success: false,
			error: { code, message: "private server detail", ...(details ? { details } : {}) },
		},
		{ status },
	);
}

async function caught(run: () => Promise<unknown>): Promise<MediaUsageActivationRequestError> {
	const error = await run().catch((value: unknown) => value);
	expect(error).toBeInstanceOf(MediaUsageActivationRequestError);
	return error as MediaUsageActivationRequestError;
}

describe("media usage activation admin API", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads and validates every public activation status field", async () => {
		const data = activationStatus("activating");
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageActivationStatus()).resolves.toEqual(data);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[0]).toBe(activationUrl);
		const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
		expect(headers.get("X-EmDash-Request")).toBe("1");
	});

	it("reads validated aggregate indexing progress", async () => {
		const data = {
			status: "indexing",
			readyCollections: 0,
			totalCollections: 2,
			indexingStarted: false,
		} as const;
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
		expect(fetch.mock.calls[0]?.[0]).toBe(progressUrl);
	});

	it("accepts an older progress response without the startup signal", async () => {
		const data = { status: "indexing", readyCollections: 1, totalCollections: 2 } as const;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
	});

	it("reads a finalizing progress snapshot", async () => {
		const data = {
			status: "indexing",
			readyCollections: 1,
			totalCollections: 2,
			indexingStarted: true,
			finalizing: true,
		} as const;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
	});

	it.each([
		[
			"false signal",
			{ status: "indexing", readyCollections: 1, totalCollections: 2, finalizing: false },
		],
		[
			"ready state",
			{ status: "ready", readyCollections: 2, totalCollections: 2, finalizing: true },
		],
		[
			"not started",
			{
				status: "indexing",
				readyCollections: 0,
				totalCollections: 2,
				indexingStarted: false,
				finalizing: true,
			},
		],
	] as const)("rejects a contradictory finalizing %s", async (_label, data) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(caught(() => fetchMediaUsageProgress())).resolves.toMatchObject({
			kind: "unknown",
		});
	});

	it("rejects a malformed progress startup signal", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			success({
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
				indexingStarted: "yes",
			}),
		);

		await expect(caught(() => fetchMediaUsageProgress())).resolves.toMatchObject({
			kind: "unknown",
		});
	});

	it("rejects progress that claims indexing has not started after a collection is ready", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			success({
				status: "indexing",
				readyCollections: 1,
				totalCollections: 2,
				indexingStarted: false,
			}),
		);

		await expect(caught(() => fetchMediaUsageProgress())).resolves.toMatchObject({
			kind: "unknown",
		});
	});

	it("rejects contradictory aggregate progress", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			success({ status: "ready", readyCollections: 2, totalCollections: 1 }),
		);

		await expect(caught(() => fetchMediaUsageProgress())).resolves.toMatchObject({
			kind: "unknown",
		});
	});

	it("accepts attention when every remaining content type is ready", async () => {
		const data = { status: "needs_attention", readyCollections: 1, totalCollections: 1 } as const;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
	});

	it("advances once with only the two backend confirmations", async () => {
		const activation = activationStatus("activating");
		const data = { outcome: "activating", processedCollections: 1, activation };
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));
		const input = {
			writersDrained: true,
			maintenanceReady: true,
			extra: "must not cross the API boundary",
		} as const;

		await expect(advanceMediaUsageActivation(input)).resolves.toEqual(data);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(activationUrl);
		expect(init?.method).toBe("POST");
		const headers = new Headers(init?.headers);
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("X-EmDash-Request")).toBe("1");
		expect(typeof init?.body).toBe("string");
		const requestBody = typeof init?.body === "string" ? init.body : "";
		expect(JSON.parse(requestBody)).toEqual({
			writersDrained: true,
			maintenanceReady: true,
		});
	});

	it.each([
		["MEDIA_USAGE_ACTIVATION_CONFLICT", "ownership_conflict"],
		["MEDIA_USAGE_ACTIVATION_VERSION_MISMATCH", "version_mismatch"],
		["VALIDATION_ERROR", "validation"],
		["MEDIA_USAGE_ACTIVATION_READ_ERROR", "read_failure"],
		["MEDIA_USAGE_ACTIVATION_ADVANCE_ERROR", "advance_failure"],
	] as const)("maps %s to %s without retaining the server message", async (code, kind) => {
		const status = code === "VALIDATION_ERROR" ? 400 : code.includes("ERROR") ? 500 : 409;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(failure(status, code));

		const error = await caught(() => fetchMediaUsageActivationStatus());

		expect(error).toMatchObject({ kind, status });
		expect(error.message).not.toContain("private server detail");
	});

	it.each([401, 403])("maps a malformed %s response to denied before parsing", async (status) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("not json", { status, statusText: "private detail" }),
		);

		await expect(caught(() => fetchMediaUsageActivationStatus())).resolves.toMatchObject({
			kind: "denied",
			status,
		});
	});

	it.each(["UNAUTHORIZED", "FORBIDDEN", "INSUFFICIENT_SCOPE"])(
		"maps %s to denied",
		async (code) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(failure(500, code));

			await expect(caught(() => fetchMediaUsageActivationStatus())).resolves.toMatchObject({
				kind: "denied",
			});
		},
	);

	it("maps a busy response without retaining server details", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				failure(409, "MEDIA_USAGE_ACTIVATION_BUSY", {
					leaseExpiresAt: "2026-08-16T09:05:00.000Z",
				}),
			)
			.mockResolvedValueOnce(failure(409, "MEDIA_USAGE_ACTIVATION_BUSY", { leaseExpiresAt: 123 }));

		await expect(caught(() => fetchMediaUsageActivationStatus())).resolves.toMatchObject({
			kind: "busy",
			status: 409,
		});
		const malformed = await caught(() => fetchMediaUsageActivationStatus());
		expect(malformed.kind).toBe("busy");
		expect(malformed).not.toHaveProperty("leaseExpiresAt");
	});

	it.each([
		["invalid state", { ...activationStatus(), state: "invalid" }],
		["negative attempts", { ...activationStatus(), attemptCount: -1 }],
		["unknown error", failure(418, "UNKNOWN_CODE")],
		["malformed JSON", new Response("not json")],
	] as const)("rejects %s as an unknown read error", async (_label, value) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			value instanceof Response ? value : success(value),
		);

		await expect(caught(() => fetchMediaUsageActivationStatus())).resolves.toMatchObject({
			kind: "unknown",
		});
	});

	it("wraps network failures without retaining their message", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("secret upstream hostname"));

		const error = await caught(() => fetchMediaUsageActivationStatus());

		expect(error).toMatchObject({ kind: "unknown", status: null });
		expect(error.message).not.toContain("secret upstream hostname");
	});

	it.each([
		["negative count", { outcome: "activating", processedCollections: -1 }],
		["count above limit", { outcome: "activating", processedCollections: 2 }],
		["fractional count", { outcome: "activating", processedCollections: 0.5 }],
		["outcome mismatch", { outcome: "active", processedCollections: 1 }],
		["nested expanded", { outcome: "activating", processedCollections: 0, state: "expanded" }],
	] as const)("treats malformed POST success (%s) as unknown", async (_label, shape) => {
		const state =
			"state" in shape ? shape.state : shape.outcome === "active" ? "activating" : shape.outcome;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			success({
				outcome: shape.outcome,
				processedCollections: shape.processedCollections,
				activation: activationStatus(state as "expanded" | "activating" | "active"),
			}),
		);

		await expect(
			caught(() => advanceMediaUsageActivation({ writersDrained: true, maintenanceReady: true })),
		).resolves.toMatchObject({ kind: "unknown", status: 200 });
	});
});
