/**
 * Tests for the optimistic mutation helpers.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { deleteDatabase } from "../../../src/lib/cache/db.js";
import {
	optimisticDelete,
	optimisticListItemUpdate,
	optimisticUpdate,
} from "../../../src/lib/cache/optimistic-mutation.js";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
}

interface TestItem {
	id: string;
	title: string;
	status?: string;
}

describe("optimistic-mutation", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = createTestQueryClient();
	});

	afterEach(async () => {
		queryClient.clear();
		await deleteDatabase();
	});

	describe("optimisticDelete", () => {
		it("removes item from query cache on mutate", async () => {
			const queryKey = ["content", "posts"];
			const items: TestItem[] = [
				{ id: "1", title: "Post 1" },
				{ id: "2", title: "Post 2" },
				{ id: "3", title: "Post 3" },
			];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticDelete<TestItem>({ queryClient, queryKey });

			await handlers.onMutate("2");

			const data = queryClient.getQueryData<{ items: TestItem[] }>(queryKey);
			expect(data?.items).toHaveLength(2);
			expect(data?.items.map((i) => i.id)).toEqual(["1", "3"]);
		});

		it("returns previous data for rollback", async () => {
			const queryKey = ["content"];
			const items: TestItem[] = [{ id: "1", title: "Post 1" }];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticDelete<TestItem>({ queryClient, queryKey });
			const context = await handlers.onMutate("1");

			expect(context.previous?.items).toHaveLength(1);
			expect(context.previous?.items[0]!.title).toBe("Post 1");
		});

		it("rolls back on error", async () => {
			const queryKey = ["content"];
			const items: TestItem[] = [
				{ id: "1", title: "Post 1" },
				{ id: "2", title: "Post 2" },
			];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticDelete<TestItem>({ queryClient, queryKey });
			const context = await handlers.onMutate("1");

			// Verify item was removed
			expect(queryClient.getQueryData<{ items: TestItem[] }>(queryKey)?.items).toHaveLength(1);

			// Simulate error -- roll back
			handlers.onError(new Error("Server error"), "1", context);

			const restored = queryClient.getQueryData<{ items: TestItem[] }>(queryKey);
			expect(restored?.items).toHaveLength(2);
		});

		it("invalidates queries on settle", () => {
			const queryKey = ["content"];
			const spy = vi.spyOn(queryClient, "invalidateQueries");

			const handlers = optimisticDelete<TestItem>({ queryClient, queryKey });
			handlers.onSettled();

			expect(spy).toHaveBeenCalledWith({ queryKey });
		});

		it("handles missing query data gracefully", async () => {
			const queryKey = ["nonexistent"];
			const handlers = optimisticDelete<TestItem>({ queryClient, queryKey });

			// Should not throw when there's no data to update
			const context = await handlers.onMutate("1");
			expect(context.previous).toBeUndefined();
		});
	});

	describe("optimisticUpdate", () => {
		it("applies update function to cached data", async () => {
			const queryKey = ["content", "post-1"];
			const original: TestItem = { id: "1", title: "Original", status: "draft" };
			queryClient.setQueryData(queryKey, original);

			const handlers = optimisticUpdate<TestItem, { status: string }>({
				queryClient,
				queryKey,
				apply: (current, vars) => ({ ...current, status: vars.status }),
			});

			await handlers.onMutate({ status: "published" });

			const updated = queryClient.getQueryData<TestItem>(queryKey);
			expect(updated?.status).toBe("published");
			expect(updated?.title).toBe("Original");
		});

		it("rolls back on error", async () => {
			const queryKey = ["content", "post-1"];
			const original: TestItem = { id: "1", title: "Original", status: "draft" };
			queryClient.setQueryData(queryKey, original);

			const handlers = optimisticUpdate<TestItem, { status: string }>({
				queryClient,
				queryKey,
				apply: (current, vars) => ({ ...current, status: vars.status }),
			});

			const context = await handlers.onMutate({ status: "published" });
			handlers.onError(new Error("fail"), { status: "published" }, context);

			const restored = queryClient.getQueryData<TestItem>(queryKey);
			expect(restored?.status).toBe("draft");
		});

		it("handles missing query data gracefully", async () => {
			const queryKey = ["nonexistent"];
			const handlers = optimisticUpdate<TestItem, { status: string }>({
				queryClient,
				queryKey,
				apply: (current, vars) => ({ ...current, status: vars.status }),
			});

			const context = await handlers.onMutate({ status: "published" });
			expect(context.previous).toBeUndefined();
		});
	});

	describe("optimisticListItemUpdate", () => {
		it("updates a specific item in a list", async () => {
			const queryKey = ["content", "posts"];
			const items: TestItem[] = [
				{ id: "1", title: "Post 1", status: "draft" },
				{ id: "2", title: "Post 2", status: "draft" },
			];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticListItemUpdate<TestItem, { id: string; status: string }>({
				queryClient,
				queryKey,
				getId: (vars) => vars.id,
				apply: (item, vars) => ({ ...item, status: vars.status }),
			});

			await handlers.onMutate({ id: "2", status: "published" });

			const data = queryClient.getQueryData<{ items: TestItem[] }>(queryKey);
			expect(data?.items[0]!.status).toBe("draft");
			expect(data?.items[1]!.status).toBe("published");
		});

		it("rolls back list on error", async () => {
			const queryKey = ["content", "posts"];
			const items: TestItem[] = [{ id: "1", title: "Post 1", status: "draft" }];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticListItemUpdate<TestItem, { id: string; status: string }>({
				queryClient,
				queryKey,
				getId: (vars) => vars.id,
				apply: (item, vars) => ({ ...item, status: vars.status }),
			});

			const context = await handlers.onMutate({ id: "1", status: "published" });

			// Verify update
			expect(queryClient.getQueryData<{ items: TestItem[] }>(queryKey)?.items[0]!.status).toBe(
				"published",
			);

			// Roll back
			handlers.onError(new Error("fail"), { id: "1", status: "published" }, context);

			const restored = queryClient.getQueryData<{ items: TestItem[] }>(queryKey);
			expect(restored?.items[0]!.status).toBe("draft");
		});

		it("leaves other items unchanged", async () => {
			const queryKey = ["content"];
			const items: TestItem[] = [
				{ id: "1", title: "A", status: "draft" },
				{ id: "2", title: "B", status: "draft" },
				{ id: "3", title: "C", status: "published" },
			];
			queryClient.setQueryData(queryKey, { items });

			const handlers = optimisticListItemUpdate<TestItem, { id: string; status: string }>({
				queryClient,
				queryKey,
				getId: (vars) => vars.id,
				apply: (item, vars) => ({ ...item, status: vars.status }),
			});

			await handlers.onMutate({ id: "2", status: "published" });

			const data = queryClient.getQueryData<{ items: TestItem[] }>(queryKey);
			expect(data?.items[0]!.status).toBe("draft"); // unchanged
			expect(data?.items[1]!.status).toBe("published"); // updated
			expect(data?.items[2]!.status).toBe("published"); // unchanged
		});
	});
});
