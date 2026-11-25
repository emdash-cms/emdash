import { beforeEach, describe, expect, it, vi } from "vitest";

const { stored } = vi.hoisted(() => ({ stored: { held: true } }));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown,
		) {}
	},
	exports: {},
}));
vi.mock("virtual:emdash/room-engine", () => ({ loadRoomEngine: null }));
vi.mock("../src/rooms/store.js", () => ({
	DurableObjectRoomStore: class {
		holdsState() {
			return stored.held;
		}
	},
}));

import { EmDashRoom } from "../src/rooms/object.js";

const HOUR = 60 * 60 * 1000;

function room() {
	const setAlarm = vi.fn(async (_at: number) => {});
	const ctx = { id: { name: "post:01" }, storage: { setAlarm }, getWebSockets: () => [] };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields EmDashRoom reads
	return { room: new EmDashRoom(ctx as never, {} as never), setAlarm };
}

describe("EmDashRoom with co-editing off", () => {
	beforeEach(() => {
		stored.held = true;
	});

	it("sets its alarm again while it holds state, so the state drops once co-editing is on", async () => {
		const { room: off, setAlarm } = room();
		const before = Date.now();
		await off.alarm();
		expect(setAlarm).toHaveBeenCalledOnce();
		expect(setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(before + HOUR);
	});

	it("lets its alarm lapse once it holds no state", async () => {
		stored.held = false;
		const { room: off, setAlarm } = room();
		await off.alarm();
		expect(setAlarm).not.toHaveBeenCalled();
	});
});
