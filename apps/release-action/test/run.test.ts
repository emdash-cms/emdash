import { describe, expect, it } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { executeAction, runAction } from "../src/run.js";
import type { ActionRuntime } from "../src/runtime.js";

const SERVICE = "https://release.example.com";
const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CREATED_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/gallery:1.2.3`;
const CREATED_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";

class FakeRuntime implements ActionRuntime {
	readonly inputs = new Map<string, string>([
		["service-url", SERVICE],
		["publisher-did", PUBLISHER_DID],
		["release-file", "release.json"],
	]);
	readonly environment = new Map<string, string>([
		["GITHUB_WORKSPACE", "/workspace"],
		["GITHUB_RUN_ID", "10000000001"],
		["GITHUB_RUN_ATTEMPT", "2"],
	]);
	readonly outputs = new Map<string, string>();
	readonly masks: string[] = [];
	readonly messages: string[] = [];
	readonly failures: string[] = [];
	tokenCount = 0;

	getInput(name: string, options: { required?: boolean } = {}): string {
		const value = this.inputs.get(name) ?? "";
		if (options.required && !value) throw new Error(`missing ${name}`);
		return value;
	}

	async getIDToken(): Promise<string> {
		this.tokenCount += 1;
		return `header.payload.signature-${this.tokenCount}`;
	}

	addMask(value: string): void {
		this.masks.push(value);
	}

	async setOutput(name: string, value: string): Promise<void> {
		this.outputs.set(name, value);
	}

	info(message: string): void {
		this.messages.push(message);
	}

	setFailed(message: string): void {
		this.failures.push(message);
	}

	getEnvironment(name: string): string | undefined {
		return this.environment.get(name);
	}
}

function intent(
	state: string,
	options: { approvalUrl?: string | null; reasonCode?: string | null; result?: unknown } = {},
) {
	return {
		id: INTENT_ID,
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		version: "1.2.3",
		state,
		stateGeneration: 5,
		reasonCode: options.reasonCode ?? null,
		workflowId: INTENT_ID,
		expiresAt: 1_800_000_000_000,
		createdAt: 1_799_999_000_000,
		updatedAt: 1_799_999_500_000,
		result: options.result ?? null,
		approvalUrl: options.approvalUrl ?? null,
	};
}

function success(data: unknown, status = 200): Response {
	return Response.json({ data, requestId: "request-1" }, { status });
}

function sequenceFetch(responses: Response[]): typeof fetch {
	let index = 0;
	return async () => responses[index++] ?? Response.json({ error: "unexpected" }, { status: 500 });
}

const dependencies = {
	readReleaseRecord: async () => structuredClone(releaseFixture),
};

describe("delegated release Action", () => {
	it("requests a fresh OIDC token, publishes, and emits stable outputs", async () => {
		const runtime = new FakeRuntime();
		const fetch = sequenceFetch([
			success({ intent: intent("received"), replayed: false }, 202),
			success({
				intent: intent("published", {
					result: { uri: CREATED_URI, cid: CREATED_CID },
				}),
			}),
		]);
		const result = await runAction(runtime, { ...dependencies, fetch });

		expect(result.state).toBe("published");
		expect(runtime.tokenCount).toBe(2);
		expect(runtime.masks).toEqual(["header.payload.signature-1", "header.payload.signature-2"]);
		expect(runtime.outputs).toEqual(
			new Map([
				["intent-id", INTENT_ID],
				["state", "published"],
				["approval-url", ""],
				["release-uri", CREATED_URI],
				["release-cid", CREATED_CID],
				["reason-code", ""],
			]),
		);
		expect(runtime.messages.at(-1)).toContain(CREATED_URI);
	});

	it("returns the approval URL without failing the job", async () => {
		const runtime = new FakeRuntime();
		const approvalUrl = `${SERVICE}/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const result = await runAction(runtime, {
			...dependencies,
			fetch: sequenceFetch([
				success({ intent: intent("received"), replayed: false }, 202),
				success({ intent: intent("awaiting_approval", { approvalUrl }) }),
			]),
		});

		expect(result.state).toBe("awaiting_approval");
		expect(runtime.outputs.get("approval-url")).toBe(approvalUrl);
		expect(runtime.failures).toEqual([]);
	});

	it("fails terminal invalid releases with a stable reason", async () => {
		const runtime = new FakeRuntime();
		await executeAction(runtime, {
			...dependencies,
			fetch: sequenceFetch([
				success({ intent: intent("received"), replayed: false }, 202),
				success({ intent: intent("invalid", { reasonCode: "PROVENANCE_INVALID" }) }),
			]),
		});

		expect(runtime.failures).toEqual(["Release intent ended in invalid (PROVENANCE_INVALID)"]);
		expect(runtime.outputs.get("reason-code")).toBe("PROVENANCE_INVALID");
	});

	it("does not expose provider failures or OIDC tokens", async () => {
		const runtime = new FakeRuntime();
		await executeAction(runtime, {
			...dependencies,
			fetch: async () => {
				throw new Error("provider detail with secret-token-value");
			},
		});

		expect(runtime.failures).toEqual(["NETWORK_ERROR: Release service request failed"]);
		expect(runtime.failures.join(" ")).not.toContain("secret-token-value");
		expect(runtime.failures.join(" ")).not.toContain("header.payload");
	});

	it("rejects invalid release input before requesting OIDC", async () => {
		const runtime = new FakeRuntime();
		await executeAction(runtime, {
			readReleaseRecord: async () => ({ package: "gallery" }),
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});

		expect(runtime.failures).toEqual(["Release record file is invalid"]);
		expect(runtime.tokenCount).toBe(0);
	});
});
