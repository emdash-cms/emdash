import { beforeAll, describe, expect, it, vi } from "vitest";

import { CLOSE_CODES } from "../../src/rooms/types.js";
import { newRoom, RoomClient } from "./room-object-client.js";

const engine = vi.hoisted(() => ({ imports: 0, actual: {} }));

vi.mock("emdash/internal/co-editing/room", () => {
	engine.imports++;
	return engine.actual;
});

describe("EmDashRoom's room engine", () => {
	// Imported outside the Durable Object: a factory that imports inside it fails on cross-object I/O.
	beforeAll(async () => {
		engine.actual = await vi.importActual("emdash/internal/co-editing/room");
	});

	it("isn't imported to answer for a fresh object or reject an upgrade to it, only once a room needs it", async () => {
		const { site, stub } = newRoom();
		expect(await stub.isOpen()).toBe(false);
		await stub.notify(["seo"]);
		expect(engine.imports).toBe(0);
		const stranger = new RoomClient("eve");
		await stranger.upgrade(stub, "not-a-token");
		await vi.waitFor(() => expect(stranger.closed?.code).toBe(CLOSE_CODES.busy));
		expect(engine.imports).toBe(0);

		const ana = await RoomClient.join(stub, site, "ana");
		expect(engine.imports).toBe(1);
		ana.close();
	});
});
