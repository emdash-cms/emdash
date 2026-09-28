/**
 * Pins that the factory the runtime calls names the absent Cloudflare binding
 * and the wrangler key that declares it.
 */

import { EmDashConfigurationError } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every factory below reads its binding off `env` when it is called, so one
// mutable object serves both the absent-binding cases and Hyperdrive's
// present-but-incomplete one. `vi.hoisted` runs before the `vi.mock` factory.
const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: {} as Record<string, unknown> }));

vi.mock("cloudflare:workers", () => ({
	env: fakeEnv,
	waitUntil: () => {},
	// `do-sql.ts` re-exports the EmDashDB class, whose module extends this.
	DurableObject: class {
		env = fakeEnv;
	},
}));

import { createObjectCache } from "../src/cache/kv.js";
import { createDialect as createD1Dialect } from "../src/db/d1.js";
import { createDialect as createDurableObjectDialect } from "../src/db/do-sql.js";
import { createDialect as createHyperdriveDialect } from "../src/db/hyperdrive.js";
import { createStorage } from "../src/storage/r2.js";

function thrown(call: () => unknown): Error & { code?: string } {
	try {
		call();
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`expected an Error, received ${String(error)}`, { cause: error });
	}
	throw new Error("expected a missing-binding error, but the call returned");
}

describe("missing binding diagnostics", () => {
	afterEach(() => {
		for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
	});

	it("names the D1 binding and the wrangler key that declares it", () => {
		const error = thrown(() => createD1Dialect({ binding: "SITE_DB" }));
		const { message } = error;
		expect(message).toContain("SITE_DB");
		expect(message).toContain("d1_databases");
		expect(error).toBeInstanceOf(EmDashConfigurationError);
		expect(error.code).toBe("BINDING_NOT_FOUND");
	});

	it("names the R2 binding and the wrangler key that declares it", () => {
		const { message } = thrown(() => createStorage({ binding: "SITE_MEDIA" }));
		expect(message).toContain("SITE_MEDIA");
		expect(message).toContain("r2_buckets");
	});

	it("gives the R2 failure a code a caller can branch on", () => {
		expect(thrown(() => createStorage({ binding: "SITE_MEDIA" })).code).toBe("BINDING_NOT_FOUND");
	});

	it("names the KV binding and the wrangler key that declares it", () => {
		const error = thrown(() => createObjectCache({ binding: "SITE_CACHE" }));
		const { message } = error;
		expect(message).toContain("SITE_CACHE");
		expect(message).toContain("kv_namespaces");
		expect(error).toBeInstanceOf(EmDashConfigurationError);
		expect(error.code).toBe("BINDING_NOT_FOUND");
	});

	it("names the Durable Object binding and the wrangler key that declares it", () => {
		const error = thrown(() => createDurableObjectDialect({ binding: "SITE_DO" }));
		const { message } = error;
		expect(message).toContain("SITE_DO");
		expect(message).toContain("durable_objects");
		expect(error).toBeInstanceOf(EmDashConfigurationError);
		expect(error.code).toBe("BINDING_NOT_FOUND");
	});

	it("names the Hyperdrive binding and the wrangler key that declares it", () => {
		const error = thrown(() => createHyperdriveDialect({ binding: "SITE_PG" }));
		const { message } = error;
		expect(message).toContain("SITE_PG");
		expect(message).toContain("hyperdrive");
		expect(error).toBeInstanceOf(EmDashConfigurationError);
		expect(error.code).toBe("BINDING_NOT_FOUND");
	});

	it("separates a Hyperdrive binding without a connection string from an absent one", () => {
		fakeEnv.SITE_PG = {};

		const error = thrown(() => createHyperdriveDialect({ binding: "SITE_PG" }));
		const { message } = error;

		expect(message).toContain("SITE_PG");
		expect(message).toContain("connectionString");
		expect(message).not.toContain("not found");
		expect(error).toBeInstanceOf(EmDashConfigurationError);
		expect(error.code).toBe("CONFIGURATION_ERROR");
	});
});
