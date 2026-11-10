import { decodeMessage } from "@emdash-cms/admin/internal/co-editing";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { CLOSE_CODES } from "../../src/rooms/types.js";
import { get, openSocket, rawUpgrade, roomPath, serve } from "./helpers.js";
import { useRoomHost } from "./room-host.js";

const NATIVE_CALLBACK = "shouldUpgradeCallback" in serve();

describe("room upgrades from the site's server", () => {
	const host = useRoomHost();

	it("attaches to a server once it serves an EmDash request", async () => {
		const { server, port } = await host.start();

		await get(`http://127.0.0.1:${port}/about`);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(server.listenerCount("upgrade")).toBe(0);

		await get(`http://127.0.0.1:${port}/_emdash/api/manifest`);
		await vi.waitFor(() => expect(server.listenerCount("upgrade")).toBe(1));
		await get(`http://127.0.0.1:${port}/_emdash/admin`);
		expect(server.listenerCount("upgrade")).toBe(1);
	});

	it("hands a room upgrade with a valid token to its room, which sends welcome", async () => {
		const { port } = await host.attached();

		const socket = await openSocket(host.roomUrl(port, await host.token()));

		expect(socket.status).toBe(101);
		expect(decodeMessage(await socket.next())).toMatchObject({ type: "welcome", access: "edit" });
		socket.ws.close();
	});

	it("takes room upgrades under a base path", async () => {
		const { port } = await host.attached();

		const socket = await openSocket(host.roomUrl(port, await host.token(), "/blog"));

		expect(decodeMessage(await socket.next())).toMatchObject({ type: "welcome" });
		socket.ws.close();
	});

	it("completes the handshake for a bad token, then closes with busy", async () => {
		const { port } = await host.attached();
		await host.token();

		const socket = await openSocket(host.roomUrl(port, "forged"));

		expect(socket.status).toBe(101);
		expect((await socket.closed).code).toBe(CLOSE_CODES.busy);
	});

	it.skipIf(!NATIVE_CALLBACK)(
		"serves other upgrade requests as plain requests where the server has shouldUpgradeCallback",
		async () => {
			const { port } = await host.attached();

			expect(await rawUpgrade(port, "/", "h2c")).toBe("HTTP/1.1 200 OK");
			expect(await rawUpgrade(port, "/live", "websocket")).toBe("HTTP/1.1 200 OK");
			expect(await rawUpgrade(port, roomPath("", "posts", "01ENTRY", "x"), "h2c")).toBe(
				"HTTP/1.1 200 OK",
			);
		},
	);

	it("answers other upgrades with 404 as the only listener, where the server has no callback", async () => {
		const { port } = await host.attached({ callback: false });

		expect(await rawUpgrade(port, "/", "h2c")).toBe("HTTP/1.1 404 Not Found");
		expect(await rawUpgrade(port, "/live", "websocket")).toBe("HTTP/1.1 404 Not Found");
		const socket = await openSocket(host.roomUrl(port, "forged"));
		expect((await socket.closed).code).toBe(CLOSE_CODES.busy);
	});

	describe.each([
		["with shouldUpgradeCallback", true],
		["without shouldUpgradeCallback", false],
	])("beside another upgrade listener, %s", (_name, callback) => {
		it.skipIf(callback && !NATIVE_CALLBACK)(
			"takes room upgrades and leaves the others to that listener",
			async () => {
				const { server, port } = await host.attached({ callback });
				// Added after the attach, so it counts only if counted at call time.
				const hmr = new WebSocketServer({ noServer: true });
				server.on("upgrade", (request, socket, head) => {
					if (request.url !== "/hmr") return;
					hmr.handleUpgrade(request, socket, head, (ws) => ws.send(new Uint8Array([7])));
				});

				const other = await openSocket(`ws://127.0.0.1:${port}/hmr`);
				expect(await other.next()).toEqual(new Uint8Array([7]));
				other.ws.close();

				const room = await openSocket(host.roomUrl(port, await host.token()));
				expect(decodeMessage(await room.next())).toMatchObject({ type: "welcome" });
				room.ws.close();
				hmr.close();
			},
		);
	});
});
