import { describe, expect, it } from "vitest";

import { generatePluginWrapper } from "../../src/sandbox/wrapper.js";

type StorageUpdate = (collection: string, id: string, args: unknown) => Promise<unknown>;

type TestEnv = { BRIDGE: { storageUpdateIf: StorageUpdate } };

interface TestEntrypoint {
	invokeHook(name: string, args: unknown): Promise<unknown>;
}

function createWrapper(storageUpdateIf: StorageUpdate): TestEntrypoint {
	const source = generatePluginWrapper({
		id: "storage-wrapper",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: { records: { indexes: ["state"] } },
		hooks: ["content:beforeSave"],
		routes: [],
		admin: {},
	})
		.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
		.replace('import pluginModule from "sandbox-plugin.js";', "")
		.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
	class WorkerEntrypoint {
		constructor(readonly env: TestEnv) {}
	}
	const pluginModule = {
		hooks: {
			"content:beforeSave": (
				args: unknown,
				ctx: {
					storage: { records: { updateIf(id: string, input: unknown): Promise<unknown> } };
				},
			) => ctx.storage.records.updateIf("constructor", args),
		},
	};
	// eslint-disable-next-line no-implied-eval -- The generated worker module is exercised in an isolated function scope.
	const factory = new Function("WorkerEntrypoint", "pluginModule", source);
	const Entrypoint = factory(WorkerEntrypoint, pluginModule) as new (
		env: TestEnv,
	) => TestEntrypoint;
	return new Entrypoint({ BRIDGE: { storageUpdateIf } });
}

describe("Cloudflare generated storage wrapper", () => {
	it("forwards literal IDs and guard arguments without changing the collection namespace", async () => {
		const args = {
			where: { state: "ready" },
			set: { state: "running" },
			collection: "other",
			id: "other-id",
		};
		const calls: Array<{ collection: string; id: string; args: unknown }> = [];
		const wrapper = createWrapper(async (collection, id, input) => {
			calls.push({ collection, id, args: input });
			return { applied: true, data: { state: "running" } };
		});

		expect(await wrapper.invokeHook("content:beforeSave", args)).toEqual({
			applied: true,
			data: { state: "running" },
		});
		expect(calls).toEqual([{ collection: "records", id: "constructor", args }]);
	});

	it("preserves malformed arguments for host validation instead of normalizing them", async () => {
		const inputs: unknown[] = [];
		const wrapper = createWrapper(async (_collection, _id, args) => {
			inputs.push(args);
			throw new TypeError("Invalid update arguments");
		});
		for (const args of [undefined, null, ["invalid"]]) {
			await expect(wrapper.invokeHook("content:beforeSave", args)).rejects.toThrow(TypeError);
		}
		expect(inputs).toEqual([undefined, null, ["invalid"]]);
	});

	it.each(["40001", "40P01", undefined])(
		"reconstructs a safe retry error with SQLSTATE %s",
		async (sqlState) => {
			const wrapper = createWrapper(async () => ({
				__emdashStorageError: {
					name: "PrivateDatabaseError",
					code: "STORAGE_SERIALIZATION_FAILURE",
					retryable: true,
					...(sqlState === undefined ? {} : { sqlState }),
					message: "private SQL and parameters",
					cause: { query: "private SQL" },
					query: "private SQL",
				},
			}));
			const outcome = await wrapper
				.invokeHook("content:beforeSave", { where: {}, set: { state: "ready" } })
				.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
			expect(outcome).toHaveProperty("error");
			if (!("error" in outcome)) throw new Error("Expected a rejected storage update");
			expect(outcome.error).toBeInstanceOf(Error);
			expect(outcome.error).toMatchObject({
				name: "StorageSerializationError",
				code: "STORAGE_SERIALIZATION_FAILURE",
				retryable: true,
				...(sqlState === undefined ? {} : { sqlState }),
				message:
					"Storage write must be retried. Restart the transaction before retrying when using an explicit transaction.",
			});
			expect(outcome.error).not.toHaveProperty("cause");
			expect(outcome.error).not.toHaveProperty("query");
			if (sqlState === undefined) expect(outcome.error).not.toHaveProperty("sqlState");
			expect(String(outcome.error)).not.toContain("private SQL");
		},
	);

	it("rejects retry envelopes carrying an unrecognized SQLSTATE", async () => {
		const wrapper = createWrapper(async () => ({
			__emdashStorageError: {
				code: "STORAGE_SERIALIZATION_FAILURE",
				retryable: true,
				sqlState: "23505",
				message: "private SQL",
				cause: "private parameters",
			},
		}));
		await expect(
			wrapper.invokeHook("content:beforeSave", { where: {}, set: { state: "ready" } }),
		).rejects.toThrow("Invalid storage error response");
	});
});
