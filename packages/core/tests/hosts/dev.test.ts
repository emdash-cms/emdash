import { decodeMessage } from "@emdash-cms/admin/internal/co-editing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestServer, type TestServerContext } from "../integration/server.js";
import { freePort } from "./fixture.js";
import { openSocket } from "./helpers.js";

/** Yjs warns with this when a process loads a second copy of it. */
const SECOND_YJS = "already imported";

describe("the integration fixture with co-editing, under astro dev", () => {
	let server: TestServerContext;
	let output = "";

	beforeAll(async () => {
		server = await createTestServer({
			port: await freePort(),
			seed: false,
			env: { EMDASH_TEST_CO_EDITING: "1" },
			onOutput: (chunk) => (output += chunk),
		});
	});

	afterAll(async () => {
		await server?.cleanup();
		expect(output).not.toContain(SECOND_YJS);
	});

	it("joins a room through a dev-bypass session and receives welcome", async () => {
		await server.client.createCollection({
			slug: "notes",
			label: "Notes",
			supports: ["drafts", "revisions"],
		});
		await server.client.createField("notes", { slug: "title", type: "string", label: "Title" });
		const note = await server.client.create("notes", { data: { title: "Hello" } });
		const session = { Cookie: server.sessionCookie, "X-EmDash-Request": "1" };
		const manifest = (await fetch(`${server.baseUrl}/_emdash/api/manifest`, {
			headers: session,
		}).then((response) => response.json())) as {
			data: { version: string; commit: string; hash: string };
		};

		const joined = await fetch(`${server.baseUrl}/_emdash/api/content/notes/${note.id}/room`, {
			method: "POST",
			headers: { ...session, "Content-Type": "application/json" },
			body: JSON.stringify({
				fingerprint: {
					version: manifest.data.version,
					commit: manifest.data.commit,
					hash: manifest.data.hash,
				},
			}),
		}).then((response) => response.json());
		expect(joined).toMatchObject({ data: { mode: "room", access: "edit" } });
		const { url, token } = (joined as { data: { url: string; token: string } }).data;

		const socket = await openSocket(
			`${server.baseUrl.replace(/^http/, "ws")}${url}?token=${encodeURIComponent(token)}`,
		);

		expect(socket.status).toBe(101);
		expect(decodeMessage(await socket.next())).toMatchObject({ type: "welcome", access: "edit" });
		socket.ws.close();
	});

	it("leaves Vite's HMR socket working", async () => {
		const hmr = await openSocket(`${server.baseUrl.replace(/^http/, "ws")}/`, {}, "vite-hmr");

		expect(hmr.status).toBe(101);
		expect(JSON.parse(new TextDecoder().decode(await hmr.next()))).toMatchObject({
			type: "connected",
		});
		hmr.ws.close();
	});
});
