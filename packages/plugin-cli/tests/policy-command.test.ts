import { parseArgs } from "citty";
import { describe, expect, it } from "vitest";

import {
	formatPolicyJsonError,
	formatPolicyJsonResult,
	policySetArgs,
	resolvePolicyCommandInput,
} from "../src/commands/policy.js";
import { ProfilePolicyError } from "../src/policy/api.js";

function resolve(rawArgs: string[]) {
	return resolvePolicyCommandInput(parseArgs(rawArgs, policySetArgs), rawArgs);
}

function expectErrorCode(action: () => unknown, code: string): void {
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code });
		return;
	}
	throw new Error(`Expected ${code}`);
}

describe("policy set command parsing", () => {
	it("maps absent, enabled, and native-negated provenance flags", () => {
		expect(resolve([]).input.requireProvenance).toBeUndefined();
		expect(resolve(["--require-provenance"]).input.requireProvenance).toBe(true);
		expect(resolve(["--no-require-provenance"]).input.requireProvenance).toBe(false);
	});

	it.each([
		["--require-provenance", "--require-provenance"],
		["--require-provenance", "--no-require-provenance"],
		["--no-require-provenance", "--no-require-provenance"],
	])("rejects repeated or contradictory provenance flags", (...rawArgs) => {
		expectErrorCode(() => resolve(rawArgs), "INVALID_POLICY_FLAGS");
	});

	it("rejects an array-valued provenance flag instead of treating it as absent", () => {
		expectErrorCode(
			() => resolvePolicyCommandInput({ "require-provenance": [true, false] }, []),
			"INVALID_POLICY_FLAGS",
		);
	});

	it("keeps Citty's repeated approver values as the replacement list", () => {
		expect(
			resolve(["--approver", "did:plc:alice", "--approver", "did:plc:bob"]).input.approvers,
		).toEqual(["did:plc:alice", "did:plc:bob"]);
	});

	it("defaults to a dry-run, applies with --yes, and supports clearing approvers", () => {
		expect(resolve([]).apply).toBe(false);
		expect(resolve(["--yes"]).apply).toBe(true);
		expect(resolve(["--clear-approvers"]).input.approvers).toEqual([]);
		expectErrorCode(
			() => resolve(["--clear-approvers", "--approver", "did:plc:alice"]),
			"INVALID_POLICY_FLAGS",
		);
	});

	it("rejects repeated clear-approvers flags", () => {
		expectErrorCode(
			() => resolve(["--clear-approvers", "--clear-approvers"]),
			"INVALID_POLICY_FLAGS",
		);
	});

	it("formats stable JSON success and error envelopes", () => {
		expect(
			formatPolicyJsonResult(
				{ profileUri: "at://did:plc:test/profile/test", written: false, diffs: [], candidate: {} },
				false,
			),
		).toEqual({
			profile: "at://did:plc:test/profile/test",
			written: false,
			applied: false,
			diffs: [],
		});
		expect(
			formatPolicyJsonResult(
				{
					profileUri: "at://did:plc:test/profile/test",
					written: false,
					diffs: [{ field: "repository", before: undefined, after: "https://example.com/repo" }],
					candidate: {},
				},
				false,
			),
		).toMatchObject({
			diffs: [{ field: "repository", before: null, after: "https://example.com/repo" }],
		});
		const stale = new ProfilePolicyError("STALE_RECORD", "stale", { expectedCid: "bafyold" });
		const errorEnvelope = formatPolicyJsonError(stale.code, stale.message, stale.detail);
		expect(errorEnvelope).toEqual({
			error: { code: "STALE_RECORD", message: "stale", detail: { expectedCid: "bafyold" } },
		});
		const stdout = `${JSON.stringify(errorEnvelope)}\n`;
		expect(stdout).toBe(
			'{"error":{"code":"STALE_RECORD","message":"stale","detail":{"expectedCid":"bafyold"}}}\n',
		);
		expect(formatPolicyJsonError("INVALID_POLICY_FLAGS", "bad flags")).toEqual({
			error: { code: "INVALID_POLICY_FLAGS", message: "bad flags" },
		});
	});
});
