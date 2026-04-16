import { describe, expect, it } from "vitest";

import { generateDialectModule } from "../../../../src/astro/integration/virtual-modules.js";

describe("generateDialectModule", () => {
	it("emits undefined createDialect and null stub when no entrypoint is configured", () => {
		const out = generateDialectModule({ supportsRequestScope: false });
		expect(out).toContain("export const createDialect = undefined");
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
	});

	it("emits a null stub for adapters that don't support request scoping", () => {
		const out = generateDialectModule({
			entrypoint: "some-adapter/dialect",
			type: "sqlite",
			supportsRequestScope: false,
		});
		expect(out).toContain(`import { createDialect as _createDialect } from "some-adapter/dialect"`);
		expect(out).toContain("export const createRequestScopedDb = (_opts) => null");
		expect(out).not.toContain(`export { createRequestScopedDb } from`);
	});

	it("re-exports createRequestScopedDb from the adapter when supportsRequestScope is true", () => {
		const out = generateDialectModule({
			entrypoint: "@emdash-cms/cloudflare/db/d1",
			type: "sqlite",
			supportsRequestScope: true,
		});
		expect(out).toContain(`export { createRequestScopedDb } from "@emdash-cms/cloudflare/db/d1"`);
		expect(out).not.toContain("= () => null");
		expect(out).not.toContain("= (_opts) => null");
	});

	it("threads the dialect type through", () => {
		const out = generateDialectModule({
			entrypoint: "emdash/db/postgres",
			type: "postgres",
			supportsRequestScope: false,
		});
		expect(out).toContain(`export const dialectType = "postgres"`);
	});
});
