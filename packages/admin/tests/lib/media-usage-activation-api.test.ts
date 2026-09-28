import { afterEach, describe, expect, it, vi } from "vitest";

import {
	MediaUsageActivationRequestError,
	advanceMediaUsageActivation,
	advanceMediaUsageProgress,
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
		} as const;
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
		expect(fetch.mock.calls[0]?.[0]).toBe(progressUrl);
	});

	it("accepts indexing while collection cleanup remains after content types are ready", async () => {
		const data = { status: "indexing", readyCollections: 2, totalCollections: 2 } as const;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(fetchMediaUsageProgress()).resolves.toEqual(data);
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

	it("advances once with only writer confirmation", async () => {
		const activation = activationStatus("activating");
		const data = { outcome: "activating", processedCollections: 1, activation };
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));
		const input = {
			writersDrained: true,
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
		});
	});

	it("advances one progress step without a request body", async () => {
		const data = {
			activation: activationStatus("active"),
			progress: { status: "ready", readyCollections: 2, totalCollections: 2 },
			nextRequestInMs: null,
		} as const;
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(success(data));

		await expect(advanceMediaUsageProgress()).resolves.toEqual(data);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(progressUrl);
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("X-EmDash-Request")).toBe("1");
		expect(init?.body).toBeUndefined();
	});

	it.each([
		[
			"active activation without progress",
			{ activation: activationStatus("active"), progress: null },
		],
		[
			"incomplete activation with progress",
			{
				activation: activationStatus("activating"),
				progress: { status: "indexing", readyCollections: 0, totalCollections: 2 },
			},
		],
	] as const)("rejects %s in a progress advance response", async (_label, value) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(success({ ...value, nextRequestInMs: null }));

		await expect(caught(() => advanceMediaUsageProgress())).resolves.toMatchObject({
			kind: "unknown",
			status: 200,
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
			caught(() => advanceMediaUsageActivation({ writersDrained: true })),
		).resolves.toMatchObject({ kind: "unknown", status: 200 });
	});
});
