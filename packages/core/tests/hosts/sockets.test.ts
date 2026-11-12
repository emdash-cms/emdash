import { once } from "node:events";

import {
	decodeMessage,
	encodeSyncStep1,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { MAX_UPDATE_BYTES } from "../../src/rooms/limits.js";
import { CLOSE_CODES } from "../../src/rooms/types.js";
import { openSocket, type OpenedSocket } from "./helpers.js";
import { useRoomHost } from "./room-host.js";

const PING_INTERVAL_MS = 30_000;

describe("room sockets", () => {
	const host = useRoomHost();

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A co-editor's socket, past the room's opening messages. */
	async function join(options: { autoPong?: boolean } = {}): Promise<OpenedSocket> {
		const { port } = await host.attached();
		const token = await host.token();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const socket = await openSocket(host.roomUrl(port, token), options);
		expect(decodeMessage(await socket.next())).toMatchObject({ type: "welcome" });
		expect(decodeMessage(await socket.next())).toMatchObject({ type: "sync-step-1" });
		return socket;
	}

	it("terminates a socket that didn't answer the last ping", async () => {
		const socket = await join({ autoPong: false });

		vi.advanceTimersByTime(PING_INTERVAL_MS);
		await once(socket.ws, "ping");
		vi.advanceTimersByTime(PING_INTERVAL_MS);

		expect((await socket.closed).code).toBe(1006);
	});

	it("keeps a socket that answers every ping", async () => {
		const socket = await join();

		for (let round = 0; round < 3; round++) {
			vi.advanceTimersByTime(PING_INTERVAL_MS);
			await once(socket.ws, "ping");
			// Lets the automatic pong reach the server before the next interval.
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		expect(socket.ws.readyState).toBe(socket.ws.OPEN);
		socket.ws.close();
	});

	it("passes binary messages to the room and ignores text", async () => {
		const socket = await join();

		// A room closes an editor's socket with `reset` for a message that doesn't decode.
		socket.ws.send("hello");
		socket.ws.send(encodeSyncStep1(new Y.Doc()));

		expect(decodeMessage(await socket.next())).toMatchObject({ type: "sync-step-2" });
		expect(socket.ws.readyState).toBe(socket.ws.OPEN);
		socket.ws.close();
	});

	it("lets the room refuse updates up to twice its limit, and closes larger frames with 1009", async () => {
		const over = await join();
		over.ws.send(encodeUpdate(new Uint8Array(MAX_UPDATE_BYTES + 1)));
		expect((await over.closed).code).toBe(CLOSE_CODES.reset);

		const far = await join();
		far.ws.send(new Uint8Array(2 * MAX_UPDATE_BYTES + 1));
		expect((await far.closed).code).toBe(1009);
	});
});
