import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client";
import {
	createMediaFolder,
	deleteMediaFolder,
	fetchMediaFolder,
	fetchMediaFolders,
	renameMediaFolder,
} from "../../src/lib/api/media";

describe("media folder API client", () => {
	const originalFetch = globalThis.fetch;
	let requests: Request[];

	beforeEach(() => {
		requests = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(request.clone());
			const url = new URL(request.url, "http://localhost");
			if (request.method === "GET" && url.pathname.endsWith("/folder%2Fone")) {
				return Response.json({ data: { item: { id: "folder/one", name: "One" } } });
			}
			if (request.method === "GET") {
				return Response.json({
					data: { items: [{ id: "folder/one", name: "One" }], nextCursor: "next" },
				});
			}
			if (request.method === "DELETE") return Response.json({ data: { deleted: true } });
			return Response.json({ data: { item: { id: "folder/one", name: "Saved" } } });
		}) as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("lists and gets folders with bounded search and encoded IDs", async () => {
		const list = await fetchMediaFolders({
			limit: 100,
			cursor: "after / folder",
			search: "  résumé  ",
		});
		const folder = await fetchMediaFolder("folder/one");

		expect(list).toEqual({ items: [{ id: "folder/one", name: "One" }], nextCursor: "next" });
		expect(folder).toEqual({ id: "folder/one", name: "One" });
		const listUrl = new URL(requests[0]!.url);
		expect(Object.fromEntries(listUrl.searchParams)).toEqual({
			limit: "100",
			cursor: "after / folder",
			q: "résumé",
		});
		expect(new URL(requests[1]!.url).pathname).toBe("/_emdash/api/media/folders/folder%2Fone");
	});

	it("creates, renames, and deletes folders with exact request bodies", async () => {
		await createMediaFolder("Created");
		await renameMediaFolder("folder/one", "Renamed");
		await deleteMediaFolder("folder/one");

		expect(requests.map((request) => request.method)).toEqual(["POST", "PUT", "DELETE"]);
		expect(await requests[0]!.json()).toEqual({ name: "Created" });
		expect(await requests[1]!.json()).toEqual({ name: "Renamed" });
		expect(new URL(requests[1]!.url).pathname).toBe("/_emdash/api/media/folders/folder%2Fone");
		expect(new URL(requests[2]!.url).pathname).toBe("/_emdash/api/media/folders/folder%2Fone");
	});

	it("surfaces the server error code and message", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				Response.json(
					{ error: { code: "CONFLICT", message: "A media folder with this name already exists" } },
					{ status: 409 },
				),
			);

		const error = await createMediaFolder("Duplicate").catch((value: unknown) => value);

		expect(error).toBeInstanceOf(ApiResponseError);
		expect(error).toMatchObject({
			status: 409,
			code: "CONFLICT",
			message: "A media folder with this name already exists",
		});
	});
});
