import type { PluginContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import { COMMERCE_LIMITS } from "../kernel/limits.js";
import type { StoredIdempotencyKey } from "../types.js";
import { handleIdempotencyCleanup } from "./cron.js";

class MemIdemp {
	constructor(public readonly rows = new Map<string, StoredIdempotencyKey>()) {}

	async query(opts: {
		where?: Record<string, unknown>;
		limit?: number;
		cursor?: string;
		orderBy?: Record<string, "asc" | "desc">;
	}) {
		const where = opts.where ?? {};
		const lt = (where.createdAt as { lt?: string } | undefined)?.lt;
		const items: Array<{ id: string; data: StoredIdempotencyKey }> = [];
		for (const [id, data] of this.rows) {
			if (lt !== undefined && typeof data.createdAt === "string" && !(data.createdAt < lt))
				continue;
			items.push({ id, data: { ...data } });
			if (items.length >= (opts.limit ?? 100)) break;
		}
		return { items, hasMore: false, cursor: undefined as string | undefined };
	}

	async deleteMany(ids: string[]): Promise<number> {
		let n = 0;
		for (const id of ids) {
			if (this.rows.delete(id)) n++;
		}
		return n;
	}
}

describe("handleIdempotencyCleanup", () => {
	it("deletes rows older than TTL", async () => {
		const old = new Date(
			Date.now() - COMMERCE_LIMITS.idempotencyRecordTtlMs - 86_400_000,
		).toISOString();
		const recent = new Date().toISOString();
		const mem = new MemIdemp();
		mem.rows.set("a", {
			route: "checkout",
			keyHash: "h1",
			httpStatus: 200,
			responseBody: {},
			createdAt: old,
		});
		mem.rows.set("b", {
			route: "checkout",
			keyHash: "h2",
			httpStatus: 200,
			responseBody: {},
			createdAt: recent,
		});

		const log = { info: vi.fn() };
		const ctx = {
			storage: { idempotencyKeys: mem },
			log,
		} as unknown as PluginContext;

		await handleIdempotencyCleanup(ctx);

		expect(mem.rows.has("a")).toBe(false);
		expect(mem.rows.has("b")).toBe(true);
		expect(log.info).toHaveBeenCalledWith(
			"commerce.cron.idempotency_cleanup",
			expect.objectContaining({ deleted: 1 }),
		);
	});
});
