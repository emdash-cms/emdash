import { afterEach, beforeEach, expect, it } from "vitest";

import { createExport } from "../../../../src/transfer/export/exporter.js";
import { MANIFEST_PATH } from "../../../../src/transfer/format/paths.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import type { TransferProgress } from "../../../../src/transfer/ops/states.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { fixtureId } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../../utils/transfer/origin-site.js";
import { driveExport, packageFiles, runExport } from "./helpers.js";

const decoder = new TextDecoder();

/** Tiny-budget exports run dozens of steps; Postgres needs more than the default timeout. */
const STEPPED_TIMEOUT = 30_000;

/** One record chunk per step. */
const tinyBudget = () => new TransferStepBudget({ bytes: 1 });

function comparable(files: Map<string, Uint8Array>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [path, bytes] of files) {
		if (path === MANIFEST_PATH) {
			const { packageId: _id, createdAt: _at, ...rest } = JSON.parse(decoder.decode(bytes));
			result[path] = rest;
		} else {
			result[path] = decoder.decode(bytes);
		}
	}
	return result;
}

describeEachDialect("site export stepping", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let site: OriginSite;
	let redirects = 0;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		site = await buildOriginSite(ctx.db, storage);
		redirects = 0;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function addRedirect(): Promise<void> {
		redirects++;
		await ctx.db
			.insertInto("_emdash_redirects")
			.values({
				id: fixtureId(5000 + redirects),
				source: `/concurrent-${redirects}`,
				destination: "/",
				type: 301,
				is_pattern: 0,
				enabled: 1,
				auto: 0,
				source_guard: 1,
			})
			.execute();
	}

	it(
		"produces the same package in many small steps as in one large step",
		async () => {
			const large = await runExport(ctx.db, storage);
			const small = await runExport(ctx.db, storage, { budget: tinyBudget });
			expect(large.steps).toBe(2);
			expect(small.steps).toBeGreaterThan(20);
			expect(small.result.outcome).toBe("complete");
			expect(comparable(await packageFiles(small.reader))).toEqual(
				comparable(await packageFiles(large.reader)),
			);
		},
		STEPPED_TIMEOUT,
	);

	it(
		"restarts after a concurrent write and records the extra attempt",
		async () => {
			const run = await runExport(ctx.db, storage, {
				budget: tinyBudget,
				beforeStep: async (step) => {
					if (step === 5) await addRedirect();
				},
			});
			expect(run.result.outcome).toBe("complete");
			const manifest = await run.reader.manifest();
			expect(manifest.fence.attempts).toBe(2);
			expect(manifest.records.redirect?.count).toBe(2);
		},
		STEPPED_TIMEOUT,
	);

	it(
		"restarts when a fenced write bumps the export's write epoch",
		async () => {
			const operations = new TransferOperationRepository(ctx.db);
			const run = await runExport(ctx.db, storage, {
				budget: tinyBudget,
				beforeStep: async (step) => {
					if (step !== 5) return;
					await ctx.db
						.updateTable("taxonomies")
						.set({ label: "Renamed" })
						.where("id", "=", site.ids.newsEn)
						.execute();
					expect(await operations.recordWriteForRunningExports()).toBe(1);
				},
			});
			expect(run.result.outcome).toBe("complete");
			expect((await run.reader.manifest()).fence.attempts).toBe(2);
			const labels: string[] = [];
			for await (const { record } of run.reader.records("term")) labels.push(record.label);
			expect(labels).toContain("Renamed");
		},
		STEPPED_TIMEOUT,
	);

	it(
		"fails with TRANSFER_EXPORT_CONCURRENT_WRITES when writes never stop",
		async () => {
			const run = await runExport(ctx.db, storage, {
				budget: tinyBudget,
				beforeStep: addRedirect,
			});
			expect(run.result.outcome).toBe("failed");
			expect(run.result.operation.errorCode).toBe("TRANSFER_EXPORT_CONCURRENT_WRITES");
		},
		STEPPED_TIMEOUT,
	);

	it(
		"starts a new attempt when a chunk it already staged is rewritten with other bytes",
		async () => {
			const operations = new TransferOperationRepository(ctx.db);
			const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
			let saved: string | null = null;
			let replayed = false;
			const run = await driveExport(ctx.db, storage, operation.id, {
				budget: tinyBudget,
				beforeStep: async () => {
					const current = await operations.require(operation.id);
					const cursor = current.cursor;
					if (saved === null && cursor?.stage === "export_records" && cursor.kind === "entry") {
						saved = JSON.stringify(cursor);
						return;
					}
					if (saved !== null && !replayed) {
						// The step that wrote the entry chunk "lost" its cursor write, and the
						// site changed without touching anything the fence watches.
						replayed = true;
						await ctx.db
							.updateTable("_emdash_transfer_operations")
							.set({ cursor: saved, stage: "export_records" })
							.where("id", "=", operation.id)
							.execute();
						await ctx.db
							.updateTable("ec_posts")
							.set({ title: "Changed behind the fence" })
							.where("id", "=", site.ids.hello)
							.execute();
					}
				},
			});
			expect(replayed).toBe(true);
			expect(run.result.operation.errorCode).toBeNull();
			expect(run.result.outcome).toBe("complete");
			expect((await run.reader.manifest()).fence.attempts).toBe(2);
			const titles: unknown[] = [];
			for await (const { record } of run.reader.records("entry")) titles.push(record.fields.title);
			expect(titles).toContain("Changed behind the fence");
		},
		STEPPED_TIMEOUT,
	);

	it(
		"reports progress on the operation as it steps",
		async () => {
			const seen: Array<TransferProgress | null> = [];
			const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
			const run = await driveExport(ctx.db, storage, operation.id, {
				budget: tinyBudget,
				beforeStep: async () => {
					seen.push((await new TransferOperationRepository(ctx.db).require(operation.id)).progress);
				},
			});
			const final = run.result.operation.progress;
			const manifest = await run.reader.manifest();
			const records = Object.values(manifest.records).reduce(
				(sum, summary) => sum + (summary?.count ?? 0),
				0,
			);
			expect(final).toEqual({
				done: final?.total,
				total: expect.any(Number),
				records,
				bytesDone: manifest.files.totalBytes,
				bytesTotal: manifest.files.totalBytes,
			});

			const reported = seen.filter((progress) => progress !== null);
			expect(reported.length).toBeGreaterThan(10);
			for (const [index, progress] of reported.entries()) {
				expect(progress.total).toBe(final?.total);
				expect(progress.done).toBeLessThan(progress.total);
				const previous = reported[index - 1];
				if (!previous) continue;
				expect(progress.done).toBeGreaterThanOrEqual(previous.done);
				expect(progress.records ?? 0).toBeGreaterThanOrEqual(previous.records ?? 0);
			}
			expect(new Set(reported.map((progress) => progress.records)).size).toBeGreaterThan(2);
		},
		STEPPED_TIMEOUT,
	);

	it("bounds media hashing by the bytes streamed, not the size column", async () => {
		await ctx.db.updateTable("media").set({ size: 1 }).execute();
		const completed: number[][] = [];
		let current: number[] = [];
		const keys = new Set(site.media.map((item) => item.storageKey));
		const download = storage.download.bind(storage);
		storage.download = async (key) => {
			const result = await download(key);
			if (!keys.has(key)) return result;
			let bytes = 0;
			const counted = result.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						bytes += chunk.byteLength;
						controller.enqueue(chunk);
					},
					flush() {
						current.push(bytes);
					},
				}),
			);
			return { ...result, body: counted };
		};
		const run = await runExport(ctx.db, storage, {
			budget: () => new TransferStepBudget({ bytes: 12 }),
			beforeStep: () => {
				completed.push(current);
				current = [];
			},
		});
		expect(run.result.outcome).toBe("complete");
		const mediaSteps = completed.filter((step) => step.length > 0);
		expect(mediaSteps.length).toBeGreaterThan(1);
		for (const step of mediaSteps) {
			const total = step.reduce((sum, bytes) => sum + bytes, 0);
			expect(step.length === 1 || total <= 12, JSON.stringify(step)).toBe(true);
		}
	});

	it("runs the package validator in its own steps until it is done", async () => {
		const calls: Array<{ state: unknown; units: number; manifestRead: boolean }> = [];
		const run = await runExport(ctx.db, storage, {
			extra: {
				validatePackage: async ({ reader, state, budget }) => {
					const manifest = await reader.manifest();
					calls.push({
						state,
						units: budget.units,
						manifestRead: manifest.records.entry !== undefined,
					});
					const next = typeof state === "number" ? state + 1 : 1;
					return { done: next === 3, state: next, blockers: [], warnings: [] };
				},
			},
		});
		expect(run.result.outcome).toBe("complete");
		expect(calls).toEqual([
			{ state: null, units: 0, manifestRead: true },
			{ state: 1, units: 0, manifestRead: true },
			{ state: 2, units: 0, manifestRead: true },
		]);
		expect(run.steps).toBe(4);
	});

	it("fails the export when the package validator reports a blocker", async () => {
		const run = await runExport(ctx.db, storage, {
			extra: {
				validatePackage: async () => ({
					done: true,
					state: null,
					blockers: [
						{ code: "dangling_reference", message: "dangling", kind: "entry", id: site.ids.hello },
					],
					warnings: [],
				}),
			},
		});
		expect(run.result.outcome).toBe("failed");
		expect(run.result.operation.errorCode).toBe("TRANSFER_EXPORT_ERROR");
		expect(run.result.operation.errorDetail).toEqual({
			reason: "package_invalid",
			blocker: "dangling_reference",
			kind: "entry",
			id: site.ids.hello,
		});
	});

	it(
		"resumes after a storage failure and produces the same package",
		async () => {
			const clean = comparable(await packageFiles((await runExport(ctx.db, storage)).reader));

			const { operation } = await createExport({ db: ctx.db, createdBy: "exporter" });
			let failures = 0;
			storage.beforeUpload = (key) => {
				if (key.includes("/records/entry/") && failures === 0) {
					failures++;
					throw new Error("injected storage failure");
				}
			};
			await expect(
				driveExport(ctx.db, storage, operation.id, { budget: tinyBudget }),
			).rejects.toThrow("Failed to store file");
			const interrupted = await new TransferOperationRepository(ctx.db).require(operation.id);
			expect(interrupted.state).toBe("running");
			expect(interrupted.leaseToken).toBeNull();

			const resumed = await driveExport(ctx.db, storage, operation.id, { budget: tinyBudget });
			expect(resumed.result.outcome).toBe("complete");
			expect(failures).toBe(1);
			expect(comparable(await packageFiles(resumed.reader))).toEqual(clean);
		},
		STEPPED_TIMEOUT,
	);
});
