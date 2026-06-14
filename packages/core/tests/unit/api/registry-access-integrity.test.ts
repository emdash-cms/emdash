import type { DeclaredAccess } from "@emdash-cms/plugin-types";
import { describe, expect, it } from "vitest";

import { enforcedAccessEqual } from "../../../src/api/handlers/registry.js";

// The install consent gate compares capability STRING SETS, which discard
// `allowedHosts`: a record advertising one host scope and a bundle enforcing
// another both reduce to `["network:request"]` and would slip through.
// `enforcedAccessEqual` compares the full enforced access -- capabilities AND
// host scope -- of the signed record against the bundle that will run.
describe("enforcedAccessEqual (record vs bundle integrity)", () => {
	it("treats identical declaredAccess as equal", () => {
		const a: DeclaredAccess = {
			content: { read: {} },
			network: { request: { allowedHosts: ["api.good.com"] } },
			email: { transport: {} },
		};
		expect(enforcedAccessEqual(a, structuredClone(a))).toBe(true);
	});

	it("rejects a bundle whose network host scope differs from the record", () => {
		const record: DeclaredAccess = { network: { request: { allowedHosts: ["api.good.com"] } } };
		const bundle: DeclaredAccess = { network: { request: { allowedHosts: ["evil.com"] } } };
		// Both reduce to the same capability set -- the string-set gate would pass.
		expect(enforcedAccessEqual(record, bundle)).toBe(false);
	});

	it("rejects host scope widening (restricted record, unrestricted bundle)", () => {
		const record: DeclaredAccess = { network: { request: { allowedHosts: ["api.good.com"] } } };
		const bundle: DeclaredAccess = { network: { request: {} } };
		expect(enforcedAccessEqual(record, bundle)).toBe(false);
	});

	it("rejects an extra capability in the bundle", () => {
		const record: DeclaredAccess = { content: { read: {} } };
		const bundle: DeclaredAccess = { content: { read: {}, write: {} } };
		expect(enforcedAccessEqual(record, bundle)).toBe(false);
	});

	it("rejects a record with no access against a capability-bearing bundle", () => {
		expect(enforcedAccessEqual({}, { email: { transport: {} } })).toBe(false);
	});

	it("is insensitive to host-list ordering (same scope, different order)", () => {
		const a: DeclaredAccess = { network: { request: { allowedHosts: ["a.com", "b.com"] } } };
		const b: DeclaredAccess = { network: { request: { allowedHosts: ["b.com", "a.com"] } } };
		expect(enforcedAccessEqual(a, b)).toBe(true);
	});
});
