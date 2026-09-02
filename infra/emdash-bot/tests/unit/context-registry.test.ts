import { describe, expect, test } from "vitest";

import { contextRegistry } from "../../.flue/lib/context-registry.js";

describe("contextRegistry", () => {
	test("reuses values within one Durable Object context", () => {
		const context = {};
		const key = `same-context-${crypto.randomUUID()}`;
		const registry = contextRegistry<object>(key, context);
		const value = {};
		registry.set("agent-1", value);

		expect(contextRegistry<object>(key, context).get("agent-1")).toBe(value);
	});

	test("does not reuse I/O-bound values across Durable Object contexts", () => {
		const firstContext = {};
		const resumedContext = {};
		const key = `resumed-context-${crypto.randomUUID()}`;
		const value = {};
		contextRegistry<object>(key, firstContext).set("agent-1", value);

		expect(contextRegistry<object>(key, resumedContext).get("agent-1")).toBeUndefined();
	});

	test("keeps independent registries separate within one context", () => {
		const context = {};
		const firstKey = `first-${crypto.randomUUID()}`;
		const secondKey = `second-${crypto.randomUUID()}`;
		contextRegistry<object>(firstKey, context).set("agent-1", {});

		expect(contextRegistry<object>(secondKey, context).has("agent-1")).toBe(false);
	});
});
