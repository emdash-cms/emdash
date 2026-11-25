import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLOSE_CODES } from "../../src/rooms/types.js";
import { buildFixture, certificate, startServer, type RunningServer } from "./fixture.js";
import { get, openSocket, roomPath } from "./helpers.js";

/** Yjs warns with this when a process loads a second copy of it. */
const SECOND_YJS = "already imported";

/**
 * Built servers can't sign in, so each mode shows the listener in place on the first socket after
 * one EmDash request: a bad token completes the handshake and then closes with `busy`.
 */
async function expectRoomUpgrades(server: RunningServer): Promise<void> {
	try {
		await get(`${server.origin}/_emdash/api/manifest`, server.ca);
		const url = server.origin.replace(/^http/, "ws") + roomPath("", "posts", "01MISSING", "forged");
		const socket = await openSocket(url, { ca: server.ca });
		expect(socket.status).toBe(101);
		expect((await socket.closed).code).toBe(CLOSE_CODES.busy);
	} finally {
		await server.stop();
	}
	expect(server.output()).not.toContain(SECOND_YJS);
}

describe("the integration fixture with co-editing, built", () => {
	let standalone: string;
	let middleware: string;
	let certificates: string;
	let tls: { key: string; cert: string } | null;

	beforeAll(async () => {
		certificates = mkdtempSync(join(tmpdir(), "emdash-hosts-tls-"));
		[standalone, middleware, tls] = await Promise.all([
			buildFixture(),
			buildFixture({ EMDASH_TEST_NODE_MODE: "middleware" }),
			certificate(certificates),
		]);
	}, 360_000);

	afterAll(() => {
		for (const dir of [standalone, middleware, certificates]) {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes room upgrades standalone over HTTP", async () => {
		await expectRoomUpgrades(await startServer(standalone, "standalone"));
	});

	it("takes room upgrades standalone over HTTPS", async (context) => {
		context.skip(tls === null, "openssl isn't installed, so there is no certificate for HTTPS");
		await expectRoomUpgrades(
			await startServer(standalone, "standalone", { tls: tls ?? undefined }),
		);
	});

	it("takes room upgrades under astro preview", async () => {
		await expectRoomUpgrades(await startServer(standalone, "preview"));
	});

	it("takes room upgrades in middleware mode under a node:http server", async () => {
		await expectRoomUpgrades(await startServer(middleware, "middleware"));
	});
});
