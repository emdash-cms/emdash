/**
 * Regression tests for env isolation when spawning workerd.
 *
 * workerd is spawned with a curated minimal env (see `minimalWorkerdEnv`)
 * rather than the parent's full `process.env`. This is defense in depth
 * against host secrets (DATABASE_URL, API keys, etc.) leaking into plugin
 * code via workerd's `nodejs_compat` `process.env` polyfill.
 *
 * Empirical check (run at PR #426 review time, workerd 1.x) showed the
 * polyfill currently exposes an empty `process.env` to plugins regardless
 * of the child env. These tests pin the minimal-env behavior so a future
 * polyfill change can't silently leak secrets.
 */

import { afterEach, describe, expect, it } from "vitest";

import { minimalWorkerdEnv } from "../src/sandbox/runner.js";

describe("minimalWorkerdEnv", () => {
	afterEach(() => {
		delete process.env.EMDASH_TEST_SECRET;
		delete process.env.EMDASH_WORKERD_PASSTHROUGH_ENV;
	});

	it("does not pass arbitrary host env vars to workerd", () => {
		process.env.EMDASH_TEST_SECRET = "shouldnotleak";

		const env = minimalWorkerdEnv();

		expect(env.EMDASH_TEST_SECRET).toBeUndefined();
		// Sanity: it should not be empty — PATH is in the allowlist and
		// is essentially always set in test environments.
		if (process.env.PATH !== undefined) {
			expect(env.PATH).toBe(process.env.PATH);
		}
	});

	it("passes through vars listed in EMDASH_WORKERD_PASSTHROUGH_ENV", () => {
		process.env.EMDASH_TEST_SECRET = "needed-by-plugin";
		process.env.EMDASH_WORKERD_PASSTHROUGH_ENV = "EMDASH_TEST_SECRET";

		const env = minimalWorkerdEnv();

		expect(env.EMDASH_TEST_SECRET).toBe("needed-by-plugin");
	});

	it("trims whitespace and ignores empty entries in the passthrough list", () => {
		process.env.EMDASH_TEST_SECRET = "value";
		process.env.EMDASH_WORKERD_PASSTHROUGH_ENV = " , EMDASH_TEST_SECRET ,  ";

		const env = minimalWorkerdEnv();

		expect(env.EMDASH_TEST_SECRET).toBe("value");
	});

	it("skips passthrough names that are not set on the host", () => {
		process.env.EMDASH_WORKERD_PASSTHROUGH_ENV = "EMDASH_DOES_NOT_EXIST_XYZ";

		const env = minimalWorkerdEnv();

		expect(env.EMDASH_DOES_NOT_EXIST_XYZ).toBeUndefined();
	});
});
