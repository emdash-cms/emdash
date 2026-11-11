/** An activated room registry over SQLite and the fake site, with servers to attach it to. */

import type { Server } from "node:http";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, vi } from "vitest";

import type { Database } from "../../src/database/types.js";
import { RoomRegistry } from "../../src/rooms/node/registry.js";
import { watchServers } from "../../src/rooms/node/upgrades.js";
import { roomId } from "../../src/rooms/types.js";
import { FakeSite } from "../unit/rooms/fake-site.js";
import { BUILD, ENTRY, FINGERPRINT, TITLE } from "../unit/rooms/test-room.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";
import { get, listen, roomPath, serve, stop } from "./helpers.js";

/** Node.js before 22.21 and 24.9: no callback, and every upgrade reaches any `upgrade` listener. */
function withoutUpgradeCallback(server: Server): void {
	const decide = function (this: Server) {
		return this.listenerCount("upgrade") > 0;
	};
	Object.defineProperty(server, "shouldUpgradeCallback", {
		configurable: true,
		get: () => (server.listenerCount("upgrade") > 0 ? decide : undefined),
		set: () => {
			throw new Error("This server has no shouldUpgradeCallback");
		},
	});
}

export interface ServerOptions {
	/** False simulates a Node.js release without `shouldUpgradeCallback`. */
	callback?: boolean;
}

export function useRoomHost() {
	let db: Kysely<Database>;
	let site: FakeSite;
	let registry: RoomRegistry;
	let servers: Server[] = [];

	beforeEach(async () => {
		watchServers();
		db = await setupTestDatabase();
		site = new FakeSite({ fields: [TITLE], data: { title: "Hello" } });
		registry = new RoomRegistry({ db, site, build: BUILD });
		registry.activate();
		servers = [];
	});

	afterEach(async () => {
		await registry.shutdown();
		await Promise.all(servers.map(stop));
		await teardownTestDatabase(db);
	});

	async function start(options: ServerOptions = {}): Promise<{ server: Server; port: number }> {
		const server = serve();
		if (options.callback === false) withoutUpgradeCallback(server);
		servers.push(server);
		return { server, port: await listen(server) };
	}

	return {
		start,
		/** A server that has served an EmDash request. */
		async attached(options: ServerOptions = {}): Promise<{ server: Server; port: number }> {
			const started = await start(options);
			await get(`http://127.0.0.1:${started.port}/_emdash/api/manifest`);
			await vi.waitFor(() => expect(started.server.listenerCount("upgrade")).toBe(1));
			return started;
		},
		async token(userId = "ana"): Promise<string> {
			const entry = site.current;
			const issued = await registry.issueToken(roomId(ENTRY), {
				userId,
				name: userId,
				access: "edit",
				fingerprint: FINGERPRINT,
				rev: entry.rev,
				status: entry.status,
				authorId: entry.authorId,
			});
			if (typeof issued !== "object" || issued === null) throw new Error(`No token: ${issued}`);
			return issued.token;
		},
		roomUrl(port: number, token: string, base = ""): string {
			return `ws://127.0.0.1:${port}${roomPath(base, ENTRY.collection, ENTRY.id, token)}`;
		},
	};
}
