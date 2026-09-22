import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginMcpConsentRequiredError } from "../../src/lib/api/marketplace";
import {
	RegistryMcpConsentRequiredError,
	RegistryUpdateEscalationError,
	updateRegistryPlugin,
} from "../../src/lib/api/registry";

const verification = {
	profileCid: "bafy-profile",
	releaseCid: "bafy-release",
	provenance: "verified",
	policy: {
		requireProvenance: true,
		confirmation: "always",
		approvers: ["did:plc:approver"],
	},
} as const;

describe("registry MCP consent errors", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchSpy = vi.fn();
		globalThis.fetch = fetchSpy as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		["missing details", undefined],
		["an empty tool list", { mcpTools: [] }],
	])("preserves the server error when MCP consent has %s", async (_label, details) => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "MCP_TOOL_CONSENT_REQUIRED",
						message: "Registry consent payload is invalid",
						...(details ? { details } : {}),
					},
				}),
				{ status: 400 },
			),
		);

		await expect(updateRegistryPlugin("my-plugin")).rejects.toThrow(
			"Registry consent payload is invalid",
		);
	});

	it("throws a consent error when the response contains MCP tools", async () => {
		const tool = {
			name: "sync",
			description: "Sync content",
			route: "sync",
			permission: "content:write",
			destructive: false,
		};
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "MCP_TOOL_CONSENT_REQUIRED",
						details: { mcpTools: [tool], verification },
					},
				}),
				{ status: 409 },
			),
		);

		const error = await updateRegistryPlugin("my-plugin").catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(PluginMcpConsentRequiredError);
		expect((error as PluginMcpConsentRequiredError).tools).toEqual([tool]);
		expect(error).toBeInstanceOf(RegistryMcpConsentRequiredError);
		expect((error as RegistryMcpConsentRequiredError).verification).toEqual(verification);
	});

	it("preserves verification evidence on capability escalation", async () => {
		fetchSpy.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: {
						code: "CAPABILITY_ESCALATION",
						message: "Plugin update requires new capabilities",
						details: {
							capabilityChanges: { added: ["users:read"], removed: [] },
							verification,
						},
					},
				}),
				{ status: 409 },
			),
		);

		const error = await updateRegistryPlugin("my-plugin").catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(RegistryUpdateEscalationError);
		expect((error as RegistryUpdateEscalationError).verification).toEqual(verification);
	});
});
