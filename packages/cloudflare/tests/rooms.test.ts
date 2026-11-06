import { RoomSaveError } from "emdash/internal/co-editing";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const ROOM_URL = "https://site.test/blog/_emdash/api/content/posts/01%20ID/room?token=abc";

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
		["an upgrade without a token", upgrade(ROOM_URL.replace("?token=abc", ""))],
		[
			"an upgrade on another path",
			upgrade("https://site.test/_emdash/api/content/posts/1?token=abc"),
		],
	])("ignores %s", (_name, request) => {
		expect(handleRoomUpgrade(request, { EMDASH_ROOMS: rooms })).toBeNull();
		expect(rooms.getByName).not.toHaveBeenCalled();
	});

	it("ignores room upgrades when the Worker has no room binding", () => {
		expect(handleRoomUpgrade(upgrade(), {})).toBeNull();
		expect(handleRoomUpgrade(upgrade(), undefined)).toBeNull();
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
