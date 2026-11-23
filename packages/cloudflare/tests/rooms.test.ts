import { CLOSE_CODES, RoomSaveError } from "emdash/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeEnv, rooms, astroFetch } = vi.hoisted(() => {
	const stub = {
		fetch: vi.fn(async (_request: Request) => new Response("room")),
		save: vi.fn(async (_actorId: string, _rev?: string): Promise<unknown> => null),
	};
	return {
		fakeEnv: {} as Record<string, unknown>,
		rooms: { stub, getByName: vi.fn((_name: string) => stub) },
		astroFetch: vi.fn(async (_request: Request) => new Response("astro")),
	};
});

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));
vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: astroFetch } }));
vi.mock("astro/app/entrypoint", () => ({ createApp: () => ({ manifest: {} }) }));
vi.mock("../src/sandbox/bridge.js", () => ({ PluginBridge: vi.fn() }));
vi.mock("../src/rooms/object.js", () => ({ EmDashRoom: vi.fn() }));
vi.mock("../src/rooms/site.js", () => ({ EmDashRoomSite: vi.fn() }));

import { createRoomHost } from "../src/rooms/host.js";
import { handleRoomUpgrade } from "../src/rooms/upgrade.js";
import worker from "../src/worker.js";

const TOKEN = "Aa0_-".repeat(8) + "Aa0";
const ROOM_PATH = "https://site.test/blog/_emdash/api/content/posts/01%20ID/room";
const ROOM_URL = `${ROOM_PATH}?token=${TOKEN}`;

function upgrade(url = ROOM_URL, method = "GET"): Request {
	return new Request(url, { method, headers: { Upgrade: "websocket" } });
}

const ctx = {} as ExecutionContext;

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
});

describe("handleRoomUpgrade", () => {
	it("forwards a room upgrade under a base path to the entry's Durable Object", async () => {
		const request = upgrade();
		const response = await handleRoomUpgrade(request, { EMDASH_ROOMS: rooms });
		expect(await response?.text()).toBe("room");
		expect(rooms.getByName).toHaveBeenCalledWith("posts:01 ID");
		expect(rooms.stub.fetch).toHaveBeenCalledWith(request);
	});

	it.each([
		["a request that isn't an upgrade", new Request(ROOM_URL)],
		["an upgrade that isn't a GET", upgrade(ROOM_URL, "POST")],
		["an upgrade without a token", upgrade(ROOM_PATH)],
		[
			"an upgrade on another path",
			upgrade(`https://site.test/_emdash/api/content/posts/1?token=${TOKEN}`),
		],
		[
			"an upgrade on a path that names no room",
			upgrade(`https://site.test/_emdash/api/content/%3Aposts/1/room?token=${TOKEN}`),
		],
	])("ignores %s", (_name, request) => {
		expect(handleRoomUpgrade(request, { EMDASH_ROOMS: rooms })).toBeNull();
		expect(rooms.getByName).not.toHaveBeenCalled();
	});

	it("ignores room upgrades when the Worker has no room binding", () => {
		expect(handleRoomUpgrade(upgrade(), {})).toBeNull();
		expect(handleRoomUpgrade(upgrade(), undefined)).toBeNull();
	});

	describe("with a token no room could have issued", () => {
		const server = { accept: vi.fn(), close: vi.fn() };
		const client = {};

		beforeEach(() => {
			vi.stubGlobal(
				"WebSocketPair",
				class {
					0 = client;
					1 = server;
				},
			);
			// Node.js refuses the 101 status a Worker completes an upgrade with.
			vi.stubGlobal(
				"Response",
				class {
					constructor(
						readonly body: null,
						readonly init: ResponseInit & { webSocket?: unknown },
					) {}
				},
			);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it.each([
			["empty", ""],
			["too short", TOKEN.slice(1)],
			["too long", `${TOKEN}A`],
			["outside base64url", `${TOKEN.slice(1)}+`],
		])("closes the socket with busy without reaching the namespace: %s", async (_name, token) => {
			const url = `${ROOM_PATH}?token=${encodeURIComponent(token)}`;
			const response = await handleRoomUpgrade(upgrade(url), { EMDASH_ROOMS: rooms });
			expect(response).toMatchObject({ init: { status: 101, webSocket: client } });
			expect(server.accept).toHaveBeenCalled();
			expect(server.close).toHaveBeenCalledWith(CLOSE_CODES.busy, "No valid token");
			expect(rooms.getByName).not.toHaveBeenCalled();
		});
	});
});

describe("the Worker's fetch", () => {
	it("forwards room upgrades before Astro runs, and leaves other requests to Astro", async () => {
		const env = { EMDASH_ROOMS: rooms };
		const fetch = worker.fetch as (
			r: Request,
			e: unknown,
			c: ExecutionContext,
		) => Promise<Response>;
		expect(await (await fetch(upgrade(), env, ctx)).text()).toBe("room");
		expect(astroFetch).not.toHaveBeenCalled();
		expect(await (await fetch(new Request(ROOM_URL), env, ctx)).text()).toBe("astro");
		expect(rooms.stub.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("createRoomHost", () => {
	it("returns null without the room binding", () => {
		expect(createRoomHost()).toBeNull();
	});

	it("throws a room's failed operation save as RoomSaveError", async () => {
		fakeEnv.EMDASH_ROOMS = rooms;
		const host = createRoomHost();
		rooms.stub.save.mockResolvedValueOnce({
			failed: { reason: "REFUSED", code: "VALIDATION_ERROR", message: "Title is required" },
		});
		const failure = await host?.save("posts:1", "ana").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RoomSaveError);
		expect(failure).toMatchObject({ reason: "REFUSED", code: "VALIDATION_ERROR" });
		expect(rooms.getByName).toHaveBeenCalledWith("posts:1");

		rooms.stub.save.mockResolvedValueOnce({ rev: "rev-2", hold: "h" });
		expect(await host?.save("posts:1", "ana", "rev-1")).toEqual({ rev: "rev-2", hold: "h" });
		expect(rooms.stub.save).toHaveBeenLastCalledWith("ana", "rev-1");
	});
});
