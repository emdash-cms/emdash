import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client";
import { joinRoom, saveRecoveryRevision, type JoinOutcome } from "../../src/lib/api/rooms";

const ENTRY = { collection: "posts", id: "01ENTRY", locale: "fr" };
const FINGERPRINT = { version: "1.4.0", commit: "abc1234", hash: "manifest-1" };

const reply = (status: number, body: unknown) =>
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
const sentJson = (init?: RequestInit): unknown =>
	typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
const failure = (code: string) => ({ success: false, error: { code, message: "No" } });

afterEach(() => vi.restoreAllMocks());

describe("joinRoom", () => {
	it.each<[string, number, unknown, JoinOutcome]>([
		[
			"a room",
			200,
			{ data: { mode: "room", url: "/room", token: "t", access: "view" } },
			{ kind: "room", url: "/room", token: "t", access: "view" },
		],
		["single-editor mode", 200, { data: { mode: "single-editor" } }, { kind: "single-editor" }],
		["a full room", 200, { data: { mode: "read-only" } }, { kind: "full" }],
		[
			"a room with an unknown access",
			200,
			{ data: { mode: "room", url: "/room", token: "t", access: "owner" } },
			{ kind: "failed" },
		],
		["an unknown mode", 200, { data: { mode: "later" } }, { kind: "failed" }],
		["a lock", 409, failure("ENTRY_LOCKED"), { kind: "locked" }],
		["a busy room", 409, failure("ROOM_BUSY"), { kind: "busy" }],
		["an outdated client", 409, failure("CLIENT_OUTDATED"), { kind: "outdated" }],
		["another conflict", 409, failure("CONFLICT"), { kind: "failed" }],
		["no session", 401, failure("UNAUTHORIZED"), { kind: "forbidden" }],
		["no access", 403, failure("FORBIDDEN"), { kind: "forbidden" }],
		["a deleted entry", 404, failure("NOT_FOUND"), { kind: "gone" }],
		["a server error", 500, failure("ROOM_JOIN_ERROR"), { kind: "failed" }],
		["a gateway error", 502, "<html>", { kind: "failed" }],
	])("maps %s", async (_name, status, body, outcome) => {
		reply(status, body);
		await expect(joinRoom(ENTRY, { fingerprint: FINGERPRINT })).resolves.toEqual(outcome);
	});

	it("maps a network failure without throwing", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(joinRoom(ENTRY, { fingerprint: FINGERPRINT })).resolves.toEqual({
			kind: "failed",
		});
	});

	it("posts the fingerprint with the CSRF header", async () => {
		const fetch = reply(200, { data: { mode: "single-editor" } });
		await joinRoom(ENTRY, { fingerprint: FINGERPRINT, takeover: true, singleEditor: false });
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe("/_emdash/api/content/posts/01ENTRY/room?locale=fr");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("X-EmDash-Request")).toBe("1");
		expect(sentJson(init)).toEqual({
			fingerprint: FINGERPRINT,
			takeover: true,
			singleEditor: false,
		});
	});
});

describe("saveRecoveryRevision", () => {
	it("posts the document to the revisions route", async () => {
		const fetch = reply(201, { data: { id: "rev1" } });
		await saveRecoveryRevision(ENTRY, { data: { title: "Kept" }, slug: "kept" });
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe("/_emdash/api/content/posts/01ENTRY/revisions?locale=fr");
		expect(sentJson(init)).toEqual({ data: { title: "Kept" }, slug: "kept" });
	});

	it("rejects with the server's error", async () => {
		reply(413, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Too large" } });
		const saving = saveRecoveryRevision(ENTRY, { data: {}, slug: null });
		await expect(saving).rejects.toBeInstanceOf(ApiResponseError);
		await expect(saving).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
	});
});
