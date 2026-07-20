import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
	fetchArtifact,
	fetchProvenance,
	type ReleaseVerifierBinding,
	VerifierUnavailableError,
} from "../src/verifier.js";

function verifierBinding(overrides: Partial<ReleaseVerifierBinding> = {}): ReleaseVerifierBinding {
	return {
		fetchArtifact: async () => ({ success: true, value: new Uint8Array([1]) }),
		fetchProvenance: async () => ({ success: true, value: new Uint8Array([2]) }),
		...overrides,
	};
}

describe("release verifier binding adapter", () => {
	it("validates results across the configured RPC service binding", async () => {
		await expect(
			fetchArtifact(env.RELEASE_VERIFIER, "https://example.test/plugin.tgz"),
		).resolves.toEqual({ success: true, value: new Uint8Array([7]) });
		await expect(
			fetchProvenance(env.RELEASE_VERIFIER, "https://example.test/provenance.json"),
		).rejects.toBeInstanceOf(VerifierUnavailableError);
	});

	it("normalizes configured service-binding failures", async () => {
		await expect(
			fetchArtifact(env.RELEASE_VERIFIER, "https://example.test/unavailable"),
		).rejects.toMatchObject({
			message: "Release verifier is unavailable",
			retryable: true,
		});
	});

	it("returns successful bytes and stable verification failures", async () => {
		await expect(
			fetchArtifact(verifierBinding(), "https://example.test/plugin.tgz"),
		).resolves.toEqual({
			success: true,
			value: new Uint8Array([1]),
		});
		const failure = {
			success: false,
			error: { code: "RESOURCE_STATUS_ERROR", message: "The resource returned HTTP 404." },
		};
		await expect(
			fetchProvenance(
				verifierBinding({ fetchProvenance: async () => failure }),
				"https://example.test/provenance.json",
			),
		).resolves.toEqual(failure);
	});

	it("preserves definitive failures from a newer verifier", async () => {
		const failure = {
			success: false as const,
			error: { code: "NEW_VERSION_CODE", message: "new definitive failure" },
		};

		await expect(
			fetchArtifact(
				verifierBinding({ fetchArtifact: async () => failure }),
				"https://example.test/plugin.tgz",
			),
		).resolves.toEqual(failure);
	});

	it("fails closed with a retryable generic error when the binding rejects", async () => {
		const cause = new Error("internal service address");
		const binding = verifierBinding({
			fetchArtifact: vi.fn().mockRejectedValue(cause),
		});
		const result = fetchArtifact(binding, "https://example.test/plugin.tgz");
		await expect(result).rejects.toBeInstanceOf(VerifierUnavailableError);
		await expect(result).rejects.toMatchObject({
			message: "Release verifier is unavailable",
			retryable: true,
			cause,
		});
	});

	it("preserves malformed response details as a diagnostic cause", async () => {
		const binding = verifierBinding({ fetchArtifact: async () => null });

		await expect(fetchArtifact(binding, "https://example.test/plugin.tgz")).rejects.toMatchObject({
			name: "VerifierUnavailableError",
			cause: expect.objectContaining({
				name: "TypeError",
				message: "Release verifier returned an invalid response",
			}),
		});
	});

	it.each([
		null,
		{ success: true, value: "not bytes" },
		{ success: false, error: { code: "FETCH_FAILED" } },
	])("rejects malformed RPC result %#", async (rpcResult) => {
		const binding = verifierBinding({ fetchArtifact: async () => rpcResult });
		await expect(fetchArtifact(binding, "https://example.test/plugin.tgz")).rejects.toMatchObject({
			name: "VerifierUnavailableError",
			retryable: true,
		});
	});
});
