import { describe, it, expect } from "vitest";

import { atproto, type AtprotoAuthConfig } from "../src/auth.js";

const PLUGIN_ROUTES_RE = /^@emdash-cms\/plugin-atproto\/routes\//;

describe("atproto auth config", () => {
	describe("AuthProviderDescriptor contract", () => {
		it("returns id 'atproto'", () => {
			const descriptor = atproto();
			expect(descriptor.id).toBe("atproto");
		});

		it("has label 'AT Protocol'", () => {
			const descriptor = atproto();
			expect(descriptor.label).toBe("AT Protocol");
		});

		it("points adminEntry to the admin module", () => {
			const descriptor = atproto();
			expect(descriptor.adminEntry).toBe("@emdash-cms/plugin-atproto/admin");
		});

		it("defaults config to empty object when no options provided", () => {
			const descriptor = atproto();
			expect(descriptor.config).toEqual({});
		});

		it("defaults config to empty object when undefined is passed", () => {
			const descriptor = atproto(undefined);
			expect(descriptor.config).toEqual({});
		});

		it("declares routes pointing to plugin package", () => {
			const descriptor = atproto();
			expect(descriptor.routes).toBeDefined();
			expect(descriptor.routes!.length).toBe(4);
			for (const route of descriptor.routes!) {
				expect(route.entrypoint).toMatch(PLUGIN_ROUTES_RE);
			}
		});

		it("declares publicRoutes with specific paths", () => {
			const descriptor = atproto();
			expect(descriptor.publicRoutes).toBeDefined();
			expect(descriptor.publicRoutes).toContain("/_emdash/api/auth/atproto/");
			// Should not have overly broad prefixes
			expect(descriptor.publicRoutes).not.toContain("/_emdash/.well-known/");
		});
	});

	describe("config passthrough", () => {
		it("passes allowedDIDs through", () => {
			const config: AtprotoAuthConfig = {
				allowedDIDs: ["did:plc:abc123", "did:web:example.com"],
			};
			const descriptor = atproto(config);
			const result = descriptor.config as AtprotoAuthConfig;
			expect(result.allowedDIDs).toEqual(["did:plc:abc123", "did:web:example.com"]);
		});

		it("passes defaultRole through", () => {
			const descriptor = atproto({ defaultRole: 20 });
			const result = descriptor.config as AtprotoAuthConfig;
			expect(result.defaultRole).toBe(20);
		});

		it("passes allowedHandles through", () => {
			const config: AtprotoAuthConfig = {
				allowedHandles: ["*.example.com", "alice.bsky.social"],
			};
			const descriptor = atproto(config);
			const result = descriptor.config as AtprotoAuthConfig;
			expect(result.allowedHandles).toEqual(["*.example.com", "alice.bsky.social"]);
		});

		it("passes full config through unchanged", () => {
			const config: AtprotoAuthConfig = {
				allowedDIDs: ["did:plc:me123"],
				allowedHandles: ["*.example.com"],
				defaultRole: 40,
			};
			const descriptor = atproto(config);
			expect(descriptor.config).toEqual(config);
		});

		it("does not mutate the input config", () => {
			const config: AtprotoAuthConfig = {
				allowedDIDs: ["did:plc:alice123"],
				allowedHandles: ["*.example.com"],
				defaultRole: 30,
			};
			const original = {
				...config,
				allowedDIDs: [...config.allowedDIDs!],
				allowedHandles: [...config.allowedHandles!],
			};
			atproto(config);
			expect(config).toEqual(original);
		});
	});

	describe("descriptor shape invariants", () => {
		it("id is always a non-empty string", () => {
			const descriptor = atproto();
			expect(typeof descriptor.id).toBe("string");
			expect(descriptor.id.length).toBeGreaterThan(0);
		});

		it("label is always a non-empty string", () => {
			const descriptor = atproto();
			expect(typeof descriptor.label).toBe("string");
			expect(descriptor.label.length).toBeGreaterThan(0);
		});

		it("adminEntry is always a non-empty string", () => {
			const descriptor = atproto();
			expect(typeof descriptor.adminEntry).toBe("string");
			expect(descriptor.adminEntry!.length).toBeGreaterThan(0);
		});
	});
});
