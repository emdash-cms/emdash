import { describe, it, expect } from "vitest";

import {
	pluginManifestSchema,
	normalizeManifestRoute,
} from "../../../src/plugins/manifest-schema.js";

/** Minimal valid manifest for testing — only storage fields vary */
function makeManifest(storage: Record<string, { indexes: Array<string | string[]> }>) {
	return {
		id: "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage,
		hooks: [],
		routes: [],
		admin: {},
	};
}

describe("pluginManifestSchema — route entries", () => {
	it("should accept plain string routes", () => {
		const result = pluginManifestSchema.safeParse(makeManifest({}));
		// Baseline with empty routes is valid
		expect(result.success).toBe(true);

		const withRoutes = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: ["webhook", "callback"],
		});
		expect(withRoutes.success).toBe(true);
	});

	it("should accept structured route objects", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: [{ name: "webhook", public: true }],
		});
		expect(result.success).toBe(true);
	});

	it("should accept a mix of strings and objects", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: ["callback", { name: "webhook", public: true }],
		});
		expect(result.success).toBe(true);
	});

	it("should reject route objects with empty name", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: [{ name: "", public: true }],
		});
		expect(result.success).toBe(false);
	});

	it("should reject route objects with missing name", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: [{ public: true }],
		});
		expect(result.success).toBe(false);
	});

	it("should accept route objects without public (defaults to private)", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: [{ name: "internal" }],
		});
		expect(result.success).toBe(true);
	});

	it("should accept route names with slashes and hyphens", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: ["auth/callback", "web-hook", { name: "api/v2/data", public: true }],
		});
		expect(result.success).toBe(true);
	});

	it("should reject route names with path traversal", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: ["../../admin/settings"],
		});
		expect(result.success).toBe(false);
	});

	it("should reject route names starting with special characters", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: ["/leading-slash"],
		});
		expect(result.success).toBe(false);
	});

	it("should reject route object names with path traversal", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			routes: [{ name: "../escape", public: true }],
		});
		expect(result.success).toBe(false);
	});
});

describe("pluginManifestSchema — hook entries", () => {
	it("should accept email:status in manifests", () => {
		const result = pluginManifestSchema.safeParse({
			...makeManifest({}),
			hooks: ["email:status"],
		});
		expect(result.success).toBe(true);
	});
});

describe("normalizeManifestRoute", () => {
	it("should convert a plain string to { name } object", () => {
		expect(normalizeManifestRoute("webhook")).toEqual({ name: "webhook" });
	});

	it("should pass through a structured object unchanged", () => {
		expect(normalizeManifestRoute({ name: "webhook", public: true })).toEqual({
			name: "webhook",
			public: true,
		});
	});

	it("should pass through an object without public", () => {
		expect(normalizeManifestRoute({ name: "internal" })).toEqual({ name: "internal" });
	});
});

describe("pluginManifestSchema — storage index field names", () => {
	it("should accept valid simple index field names", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: ["status", "createdAt", "count"] },
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should accept valid composite index field names", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: [["status", "createdAt"]] },
			}),
		);
		expect(result.success).toBe(true);
	});

	it("should reject index field names containing SQL injection payloads", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: ["'); DROP TABLE users--"] },
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject index field names with dots (JSON path traversal)", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: ["nested.field"] },
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject index field names with hyphens", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: ["my-field"] },
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject index field names starting with a number", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: ["1field"] },
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject empty index field names", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: [""] },
			}),
		);
		expect(result.success).toBe(false);
	});

	it("should reject malicious field names in composite indexes", () => {
		const result = pluginManifestSchema.safeParse(
			makeManifest({
				items: { indexes: [["status", "'); DROP TABLE--"]] },
			}),
		);
		expect(result.success).toBe(false);
	});
});
