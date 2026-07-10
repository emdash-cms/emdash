import { PublishingClient } from "@emdash-cms/registry-client";
import type { Did } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import { canonicaliseRepository, ProfilePolicyError, setProfilePolicy } from "../src/policy/api.js";
import { MockPds } from "./mock-pds.js";

const DID: Did = "did:plc:test123";
const SLUG = "test-plugin";
const NOW = new Date("2026-07-10T12:00:00.000Z");

function publisher(pds: MockPds): PublishingClient {
	return PublishingClient.fromHandler({ handler: pds, did: pds.did, pds: "http://mock.test" });
}

function seedProfile(pds: MockPds, overrides: Record<string, unknown> = {}) {
	pds.seedRecord(NSID.packageProfile, SLUG, {
		$type: NSID.packageProfile,
		id: `at://${DID}/${NSID.packageProfile}/${SLUG}`,
		type: "emdash-plugin",
		license: "MIT",
		authors: [{ name: "Alice" }],
		security: [{ email: "security@example.com" }],
		slug: SLUG,
		lastUpdated: "2024-01-01T00:00:00.000Z",
		...overrides,
	});
}

function set(pds: MockPds, input: Parameters<typeof setProfilePolicy>[0]["input"], apply = false) {
	return setProfilePolicy({ publisher: publisher(pds), slug: SLUG, input, apply, now: () => NOW });
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

describe("setProfilePolicy", () => {
	it("dry-runs policy changes without writing", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://github.com/example/plugin" },
			},
		});
		const result = await set(pds, { requireProvenance: true });
		expect(result.written).toBe(false);
		expect(result.candidate.lastUpdated).toBe(NOW.toISOString());
		expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
	});

	it("applies with CAS and preserves unknown profile and extension data", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			futureField: { preserved: true },
			extensions: {
				[NSID.packageProfileExtension]: {
					repository: "https://github.com/example/plugin",
					future: { keep: true },
				},
				"com.example.other": { $type: "com.example.other", exact: ["keep"] },
			},
		});
		const result = await set(pds, { requireProvenance: true }, true);
		expect(result.written).toBe(true);
		const put = pds.callsTo("com.atproto.repo.putRecord")[0]!.body as {
			swapRecord?: string;
			validate?: boolean;
			record: Record<string, unknown>;
		};
		expect(put.swapRecord).toBeTruthy();
		expect(put.validate).toBe(false);
		expect(put.record.futureField).toEqual({ preserved: true });
		const extensions = put.record.extensions as Record<string, Record<string, unknown>>;
		expect(extensions["com.example.other"]).toEqual({
			$type: "com.example.other",
			exact: ["keep"],
		});
		expect(extensions[NSID.packageProfileExtension]).toMatchObject({
			$type: NSID.packageProfileExtension,
			repository: "https://github.com/example/plugin",
			future: { keep: true },
			releasePolicy: { requireProvenance: true },
		});
	});

	it("requires a repository to create an extension and preserves it later", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds);
		await expect(set(pds, { requireProvenance: true })).rejects.toMatchObject({
			code: "REPOSITORY_REQUIRED",
		});
		await set(
			pds,
			{ repository: "https://github.com/example/plugin", requireProvenance: true },
			true,
		);
		await set(pds, { confirmation: "always" }, true);
		const stored = pds.records.get(`at://${DID}/${NSID.packageProfile}/${SLUG}`)!.value as Record<
			string,
			unknown
		>;
		expect(
			(stored.extensions as Record<string, Record<string, unknown>>)[NSID.packageProfileExtension]
				.repository,
		).toBe("https://github.com/example/plugin");
	});

	it("writes a strict policy exactly", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://github.com/example/plugin" },
			},
		});
		await set(
			pds,
			{ requireProvenance: true, confirmation: "always", approvers: ["did:plc:alice"] },
			true,
		);
		const stored = pds.records.get(`at://${DID}/${NSID.packageProfile}/${SLUG}`)!.value as Record<
			string,
			unknown
		>;
		expect(
			(stored.extensions as Record<string, Record<string, unknown>>)[NSID.packageProfileExtension]
				.releasePolicy,
		).toEqual({ requireProvenance: true, confirmation: "always", approvers: ["did:plc:alice"] });
	});

	it("normalizes approver DIDs before storing and detecting duplicates", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://github.com/example/plugin" },
			},
		});
		await set(pds, { approvers: [" did:plc:alice "] }, true);
		const stored = pds.records.get(`at://${DID}/${NSID.packageProfile}/${SLUG}`)!.value as Record<
			string,
			unknown
		>;
		expect(
			(stored.extensions as Record<string, Record<string, unknown>>)[NSID.packageProfileExtension]
				.releasePolicy,
		).toEqual({ approvers: ["did:plc:alice"] });
		await expect(
			set(pds, { approvers: ["did:plc:alice", " did:plc:alice "] }),
		).rejects.toMatchObject({ code: "INVALID_APPROVERS" });
	});

	it("treats the same approvers in a different order as a no-op", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: {
					repository: "https://github.com/example/plugin",
					releasePolicy: { approvers: ["did:plc:alice", "did:plc:bob"] },
				},
			},
		});
		const result = await set(pds, { approvers: ["did:plc:bob", "did:plc:alice"] }, true);
		expect(result.diffs).toEqual([]);
		expect(result.written).toBe(false);
	});

	it("writes an explicit empty approver list", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: {
					repository: "https://github.com/example/plugin",
					releasePolicy: { approvers: ["did:plc:alice"] },
				},
			},
		});
		await set(pds, { approvers: [] }, true);
		const stored = pds.records.get(`at://${DID}/${NSID.packageProfile}/${SLUG}`)!.value as Record<
			string,
			unknown
		>;
		expect(
			(stored.extensions as Record<string, Record<string, unknown>>)[NSID.packageProfileExtension]
				.releasePolicy,
		).toEqual({ approvers: [] });
	});

	it.each([
		[{ confirmation: "manual-review" }, "INVALID_CONFIRMATION"],
		[{ repository: "http://example.com/repo" }, "INVALID_REPOSITORY"],
		[{ approvers: ["not-a-did"] }, "INVALID_APPROVERS"],
		[{ approvers: ["did:plc:alice", "did:plc:alice"] }, "INVALID_APPROVERS"],
	] as const)("rejects invalid policy input before writing", async (input, code) => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://github.com/example/plugin" },
			},
		});
		await expect(set(pds, input)).rejects.toMatchObject({ code });
		expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
	});

	it("canonicalizes a new repository anchor before writing", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds);
		await set(pds, { repository: "https://GitHub.com/Example/Plugin///" }, true);
		const stored = pds.records.get(`at://${DID}/${NSID.packageProfile}/${SLUG}`)!.value as Record<
			string,
			unknown
		>;
		expect(
			(stored.extensions as Record<string, Record<string, unknown>>)[NSID.packageProfileExtension]
				.repository,
		).toBe("https://github.com/Example/Plugin");
	});

	it.each([
		["http://example.com/repo"],
		["https://user@example.com/repo"],
		["https://example.com/repo?ref=main"],
		["https://example.com/repo#readme"],
		["https://example.com:8443/repo"],
	] as const)("rejects a non-canonicalizable repository input", (repository) => {
		expectErrorCode(() => canonicaliseRepository(repository), "INVALID_REPOSITORY");
	});

	it("preserves root slashes and path case when canonicalizing repositories", () => {
		expect(canonicaliseRepository("https://EXAMPLE.com/")).toBe("https://example.com/");
		expect(canonicaliseRepository("https://EXAMPLE.com///")).toBe("https://example.com/");
		expect(canonicaliseRepository("https://EXAMPLE.com/Owner/Repo.git/")).toBe(
			"https://example.com/Owner/Repo.git",
		);
	});

	it("refuses a non-canonical existing repository anchor", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://GitHub.com/example/plugin/" },
			},
		});
		await expect(set(pds, { requireProvenance: true })).rejects.toMatchObject({
			code: "PROFILE_EXTENSION_INVALID",
		});
	});

	it("maps a stale CAS write to a stable error", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: { repository: "https://github.com/example/plugin" },
			},
		});
		const handle = pds.handle.bind(pds);
		pds.handle = async (pathname, init) =>
			pathname.includes("putRecord")
				? new Response(JSON.stringify({ error: "InvalidSwap" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					})
				: handle(pathname, init);
		await expect(set(pds, { requireProvenance: true }, true)).rejects.toBeInstanceOf(
			ProfilePolicyError,
		);
		await expect(set(pds, { requireProvenance: true }, true)).rejects.toMatchObject({
			code: "STALE_RECORD",
		});
	});

	it("does not write or change lastUpdated for a no-op apply", async () => {
		const pds = new MockPds({ did: DID });
		seedProfile(pds, {
			extensions: {
				[NSID.packageProfileExtension]: {
					repository: "https://github.com/example/plugin",
					releasePolicy: { requireProvenance: true },
				},
			},
		});
		const result = await set(pds, { requireProvenance: true }, true);
		expect(result.written).toBe(false);
		expect(result.candidate.lastUpdated).toBe("2024-01-01T00:00:00.000Z");
		expect(pds.callsTo("com.atproto.repo.putRecord")).toHaveLength(0);
	});
});
