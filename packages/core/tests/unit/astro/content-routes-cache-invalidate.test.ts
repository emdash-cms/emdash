/**
 * PUT content updates must only purge edge cache tags when live/public
 * content actually changed. Pure draft staging on revision collections
 * leaves live columns untouched and must not thrash Workers Cache.
 */

import { Role } from "@emdash-cms/auth";
import { describe, it, expect, vi } from "vitest";

import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";

describe("PUT content route — edge cache invalidation", () => {
	const makeUser = () => ({
		id: "user-1",
		role: Role.EDITOR,
	});

	const ownedItem = {
		success: true as const,
		data: { item: { id: "c1", authorId: "user-1" }, _rev: "rev1" },
	};

	async function putWithUpdateResult(
		updateResult: {
			success: boolean;
			data?: unknown;
			liveContentChanged?: boolean;
			error?: { code: string; message: string };
		},
		body: Record<string, unknown> = { data: { title: "Edited" } },
	) {
		const handleContentGet = vi.fn().mockResolvedValue(ownedItem);
		const handleContentUpdate = vi.fn().mockResolvedValue(updateResult);
		const invalidate = vi.fn().mockResolvedValue(undefined);

		const request = new Request("http://localhost/_emdash/api/content/posts/c1", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		const response = await updateContent({
			params: { collection: "posts", id: "c1" },
			request,
			url: new URL(request.url),
			locals: {
				emdash: { handleContentUpdate, handleContentGet },
				user: makeUser(),
			},
			cache: { enabled: true, invalidate },
		} as Parameters<typeof updateContent>[0]);

		return { response, invalidate, handleContentUpdate };
	}

	it("does not invalidate when liveContentChanged is false (draft-only save)", async () => {
		const { response, invalidate } = await putWithUpdateResult({
			success: true,
			data: { item: { id: "c1" }, _rev: "rev2" },
			liveContentChanged: false,
		});

		expect(response.status).toBe(200);
		expect(invalidate).not.toHaveBeenCalled();
		const json = await response.json();
		expect(json).toMatchObject({ success: true, data: { item: { id: "c1" } } });
		expect(json).not.toHaveProperty("liveContentChanged");
		expect(json.data).not.toHaveProperty("liveContentChanged");
	});

	it("invalidates when liveContentChanged is true", async () => {
		const { response, invalidate } = await putWithUpdateResult({
			success: true,
			data: { item: { id: "c1" }, _rev: "rev2" },
			liveContentChanged: true,
		});

		expect(response.status).toBe(200);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith({ tags: ["posts", "c1"] });
	});

	it("invalidates when liveContentChanged is omitted (safe default)", async () => {
		const { response, invalidate } = await putWithUpdateResult({
			success: true,
			data: { item: { id: "c1" }, _rev: "rev2" },
		});

		expect(response.status).toBe(200);
		expect(invalidate).toHaveBeenCalledWith({ tags: ["posts", "c1"] });
	});

	it("does not invalidate on failed updates", async () => {
		const { response, invalidate } = await putWithUpdateResult({
			success: false,
			error: { code: "CONFLICT", message: "stale" },
			liveContentChanged: true,
		});

		expect(response.status).toBe(409);
		expect(invalidate).not.toHaveBeenCalled();
	});
});
