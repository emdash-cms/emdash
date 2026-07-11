import { describe, expect, it } from "vitest";

import {
	canonicalizeDeclaredAccess,
	declaredAccessDigestInput,
	declaredAccessEqual,
	diffDeclaredAccess,
	isDeclaredAccessEscalation,
} from "../src/index.js";
import type { DeclaredAccess } from "../src/index.js";

const access = (allowedHosts?: string[]): DeclaredAccess => ({
	network: { request: allowedHosts === undefined ? {} : { allowedHosts } },
});
const sparseArray: unknown[] = [];
sparseArray.length = 1;

describe("declared access escalation decision table", () => {
	const cases: Array<{
		name: string;
		previous: DeclaredAccess;
		next: DeclaredAccess;
		escalation: boolean;
	}> = [
		{ name: "equal empty access", previous: {}, next: {}, escalation: false },
		{
			name: "first release with access",
			previous: {},
			next: { users: { read: {} } },
			escalation: true,
		},
		{
			name: "category removal",
			previous: { users: { read: {} } },
			next: {},
			escalation: false,
		},
		{
			name: "operation addition",
			previous: { email: { send: {} } },
			next: { email: { send: {}, events: {} } },
			escalation: true,
		},
		{
			name: "operation removal",
			previous: { email: { send: {}, events: {} } },
			next: { email: { send: {} } },
			escalation: false,
		},
		{
			name: "restricted to unrestricted",
			previous: access(["api.example.com"]),
			next: access(),
			escalation: true,
		},
		{
			name: "unrestricted to restricted",
			previous: access(),
			next: access(["api.example.com"]),
			escalation: false,
		},
		{
			name: "deny-all to restricted",
			previous: access([]),
			next: access(["api.example.com"]),
			escalation: true,
		},
		{
			name: "restricted to deny-all",
			previous: access(["api.example.com"]),
			next: access([]),
			escalation: false,
		},
		{
			name: "wildcard covers exact subdomain",
			previous: access(["*.example.com"]),
			next: access(["api.example.com"]),
			escalation: false,
		},
		{
			name: "wildcard excludes bare domain",
			previous: access(["*.example.com"]),
			next: access(["example.com"]),
			escalation: true,
		},
		{
			name: "wildcard covers narrower wildcard",
			previous: access(["*.example.com"]),
			next: access(["*.api.example.com"]),
			escalation: false,
		},
		{
			name: "exact does not cover wildcard",
			previous: access(["api.example.com"]),
			next: access(["*.api.example.com"]),
			escalation: true,
		},
		{
			name: "exact covers itself",
			previous: access(["api.example.com"]),
			next: access(["api.example.com"]),
			escalation: false,
		},
		{
			name: "exact excludes another host",
			previous: access(["api.example.com"]),
			next: access(["cdn.example.com"]),
			escalation: true,
		},
		{
			name: "star covers every host",
			previous: access(["*"]),
			next: access(["example.com", "*.api.example.com"]),
			escalation: false,
		},
	];

	it.each(cases)("$name", ({ previous, next, escalation }) => {
		const diff = diffDeclaredAccess(previous, next);
		expect(diff.escalation).toBe(escalation);
		expect(isDeclaredAccessEscalation(previous, next)).toBe(diff.escalation);
	});
});

describe("canonicalizeDeclaredAccess", () => {
	it("materializes write implications without mutating input and is idempotent", () => {
		const input: DeclaredAccess = { media: { write: {} }, content: { write: {} } };
		const canonical = canonicalizeDeclaredAccess(input);
		expect(canonical).toEqual({ content: { read: {}, write: {} }, media: { read: {}, write: {} } });
		expect(input).toEqual({ media: { write: {} }, content: { write: {} } });
		expect(canonicalizeDeclaredAccess(canonical)).toEqual(canonical);
		expect(Object.isFrozen(canonical)).toBe(true);
		expect(
			declaredAccessEqual({ content: { write: {} } }, { content: { read: {}, write: {} } }),
		).toBe(true);
	});

	it("sorts keys recursively and host sets while preserving other array order", () => {
		const first = {
			network: {
				request: { z: { b: 2, a: 1 }, list: [2, 1], allowedHosts: ["b.test", "a.test", "b.test"] },
			},
		} as DeclaredAccess;
		const second = {
			network: { request: { allowedHosts: ["a.test", "b.test"], list: [2, 1], z: { a: 1, b: 2 } } },
		} as DeclaredAccess;
		expect(declaredAccessEqual(first, second)).toBe(true);
		expect(canonicalizeDeclaredAccess(first).network?.request?.allowedHosts).toEqual([
			"a.test",
			"b.test",
		]);
		expect(
			declaredAccessEqual(first, {
				network: { request: { ...second.network?.request, list: [1, 2] } },
			} as DeclaredAccess),
		).toBe(false);
	});

	it.each([
		["undefined", { users: { read: { value: undefined } } }],
		["function", { users: { read: { value: () => undefined } } }],
		["NaN", { users: { read: { value: Number.NaN } } }],
		["sparse array", { users: { read: { value: sparseArray } } }],
	])("rejects malformed %s runtime values", (_, value) => {
		expect(() => declaredAccessDigestInput(value as DeclaredAccess)).toThrow(TypeError);
	});
});

describe("unknown constraints", () => {
	const unknown = (constraints: Record<string, unknown>): DeclaredAccess => ({
		users: { read: constraints },
	});
	const fromJson = (constraints: string): DeclaredAccess =>
		JSON.parse(`{"users":{"read":${constraints}}}`) as DeclaredAccess;

	it.each([
		["equal", unknown({ policy: { b: 2, a: 1 } }), unknown({ policy: { a: 1, b: 2 } }), false],
		["added", unknown({}), unknown({ policy: true }), true],
		["removed", unknown({ policy: true }), unknown({}), true],
		["changed", unknown({ policy: 1 }), unknown({ policy: 2 }), true],
		[
			"nested array equal",
			unknown({ policy: { values: [1, 2] } }),
			unknown({ policy: { values: [1, 2] } }),
			false,
		],
		[
			"nested array reordered",
			unknown({ policy: { values: [1, 2] } }),
			unknown({ policy: { values: [2, 1] } }),
			true,
		],
	] as const)("handles %s unknown constraints conservatively", (_, previous, next, escalation) => {
		expect(diffDeclaredAccess(previous, next).escalation).toBe(escalation);
	});

	it("preserves JSON-derived __proto__ constraints without equality or digest collisions", () => {
		const constrained = fromJson('{"__proto__":{"scope":"all"}}');
		const empty = unknown({});

		expect(declaredAccessEqual(constrained, empty)).toBe(false);
		expect(declaredAccessDigestInput(constrained)).not.toBe(declaredAccessDigestInput(empty));
	});

	it("reports changed and removed __proto__ constraints as deterministic escalations", () => {
		const previous = fromJson('{"__proto__":{"level":1}}');
		const next = fromJson('{"__proto__":{"level":2}}');

		expect(diffDeclaredAccess(previous, next)).toEqual({
			changes: [
				{
					kind: "constraint-changed",
					category: "users",
					operation: "read",
					path: ["users", "read", "__proto__"],
					previous: { level: 1 },
					next: { level: 2 },
					escalation: true,
				},
			],
			escalation: true,
		});
		expect(diffDeclaredAccess(previous, unknown({}))).toEqual({
			changes: [
				{
					kind: "constraint-removed",
					category: "users",
					operation: "read",
					path: ["users", "read", "__proto__"],
					previous: { level: 1 },
					next: undefined,
					escalation: true,
				},
			],
			escalation: true,
		});
	});

	it("keeps canonical __proto__ values idempotent with safe object prototypes", () => {
		const canonical = canonicalizeDeclaredAccess(fromJson('{"__proto__":{"enabled":true}}'));
		const constraints = canonical.users?.read;

		expect(Object.hasOwn(constraints ?? {}, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(constraints)).toBe(Object.prototype);
		expect(canonicalizeDeclaredAccess(canonical)).toEqual(canonical);
	});

	it("preserves and compares constructor and prototype constraints", () => {
		const previous = fromJson('{"constructor":{"mode":"old"},"prototype":{"enabled":true}}');
		const next = fromJson('{"constructor":{"mode":"new"},"prototype":{"enabled":true}}');

		expect(canonicalizeDeclaredAccess(previous).users?.read).toEqual({
			constructor: { mode: "old" },
			prototype: { enabled: true },
		});
		expect(declaredAccessEqual(previous, next)).toBe(false);
		expect(diffDeclaredAccess(previous, next).changes).toEqual([
			{
				kind: "constraint-changed",
				category: "users",
				operation: "read",
				path: ["users", "read", "constructor"],
				previous: { mode: "old" },
				next: { mode: "new" },
				escalation: true,
			},
		]);
	});

	it("rejects symbol-keyed own properties", () => {
		const constraints = {};
		Object.defineProperty(constraints, Symbol("constraint"), {
			value: true,
			enumerable: true,
		});

		expect(() => canonicalizeDeclaredAccess(unknown(constraints))).toThrow(TypeError);
	});
});

describe("structured diff", () => {
	it("has deterministic ordering, machine-readable paths, and no display strings", () => {
		const diff = diffDeclaredAccess(
			{ users: { read: { z: 1 } }, email: { send: {} } },
			{ users: { read: { a: 1 } }, content: { read: {} }, email: { events: {} } },
		);
		expect(diff.changes.map(({ kind, path, escalation }) => ({ kind, path, escalation }))).toEqual([
			{ kind: "category-added", path: ["content"], escalation: true },
			{ kind: "operation-added", path: ["email", "events"], escalation: true },
			{ kind: "operation-removed", path: ["email", "send"], escalation: false },
			{ kind: "constraint-added", path: ["users", "read", "a"], escalation: true },
			{ kind: "constraint-removed", path: ["users", "read", "z"], escalation: true },
		]);
		for (const item of diff.changes) {
			expect(Object.keys(item).toSorted()).toEqual(
				["category", "escalation", "kind", "next", "operation", "path", "previous"].toSorted(),
			);
		}
	});
});

describe("declaredAccessDigestInput", () => {
	it("is domain/version separated and stable for semantic equality", () => {
		const implied = declaredAccessDigestInput({ content: { write: {} } });
		expect(implied).toBe(declaredAccessDigestInput({ content: { read: {}, write: {} } }));
		expect(implied).toContain('"domain":"@emdash-cms/plugin-types/declared-access"');
		expect(implied).toContain('"version":1');
		expect(implied).not.toBe(declaredAccessDigestInput({ content: { read: {} } }));
	});
});
