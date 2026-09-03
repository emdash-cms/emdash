import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import type { PreparedReleaseFiles } from "../src/prepare.js";
import { executeAction, runAction } from "../src/run.js";
import type { ActionRuntime } from "../src/runtime.js";

const SERVICE = "https://release.example.com";
const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CREATED_URI = `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.release/gallery:1.2.3`;
const CREATED_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROVENANCE_CHECKSUM = "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONNECTION_INVITATION = `ewci1_${"I".repeat(43)}`;

function sourceRelease(): PackageRelease.Main {
	const release = structuredClone(releaseFixture) as PackageRelease.Main;
	release.artifacts.package.checksum = CHECKSUM;
	release.extensions = {
		[NSID.packageReleaseExtension]: {
			$type: NSID.packageReleaseExtension,
			declaredAccess: {},
			provenance: {
				url: "https://example.com/provenance.json",
				checksum: CHECKSUM,
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/example/gallery",
				builderId:
					"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
			},
		},
	};
	return release;
}

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
	readonly summaries: string[] = [];
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

	async writeSummary(markdown: string): Promise<void> {
		this.summaries.push(markdown);
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

function failure(code: string, message: string, status: number): Response {
	return Response.json({ error: { code, message }, requestId: "request-1" }, { status });
}

function policy() {
	return {
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/tags/*"],
		allowedEnvironments: ["production"],
		active: true,
		stateVersion: 1,
		authorizedBy: PUBLISHER_DID,
		createdAt: 1_800_000_000_000,
		updatedAt: 1_800_000_000_000,
	};
}

function connectionRequest() {
	return {
		id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
		packageSlug: "gallery",
		state: "pending",
		claim: {
			repository: "example/gallery",
			repositoryId: "123456789",
			repositoryOwner: "example",
			repositoryOwnerId: "987654321",
			repositoryVisibility: "private",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			ref: "refs/tags/v1.2.3",
			environment: "production",
		},
		refScope: null,
		expiresAt: 1_800_086_400_000,
		createdAt: 1_800_000_000_000,
		confirmedAt: null,
	};
}

function sequenceFetch(responses: Response[]): typeof fetch {
	let index = 0;
	return async () => responses[index++] ?? Response.json({ error: "unexpected" }, { status: 500 });
}

const dependencies = {
	readReleaseRecord: async () => sourceRelease(),
};

function preparedFiles(): PreparedReleaseFiles {
	return {
		packageSlug: "gallery",
		version: "1.2.3",
		packageBytes: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
		packageChecksum: CHECKSUM,
		provenanceBytes: new TextEncoder().encode('{"sigstore":"bundle"}\n'),
		provenanceChecksum: PROVENANCE_CHECKSUM,
		declaredAccess: {},
		sourceRepository: "https://github.com/example/gallery",
		builderId:
			"https://github.com/example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
	};
}

describe("delegated release Action", () => {
	it("requests a fresh OIDC token, publishes, and emits stable outputs", async () => {
		const runtime = new FakeRuntime();
		runtime.inputs.set("connection-invitation", CONNECTION_INVITATION);
		const responses = sequenceFetch([
			success({ status: "connected", policy: policy() }),
			success({ intent: intent("received"), replayed: false }, 202),
			success({
				intent: intent("published", {
					result: { uri: CREATED_URI, cid: CREATED_CID },
				}),
			}),
		]);
		const requests: Request[] = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			requests.push(new Request(input, init));
			return responses(input, init);
		};
		const result = await runAction(runtime, { ...dependencies, fetch });

		expect(result.state).toBe("published");
		expect(runtime.tokenCount).toBe(3);
		expect(runtime.masks).toEqual([
			CONNECTION_INVITATION,
			"header.payload.signature-1",
			"header.payload.signature-2",
			"header.payload.signature-3",
		]);
		expect(runtime.outputs).toEqual(
			new Map([
				["connection-url", ""],
				["intent-id", INTENT_ID],
				["state", "published"],
				["approval-url", ""],
				["release-uri", CREATED_URI],
				["release-cid", CREATED_CID],
				["reason-code", ""],
			]),
		);
		expect(runtime.messages.at(-1)).toContain(CREATED_URI);
		expect(requests[0]?.headers.get("idempotency-key")).toBe(
			"github-connection-10000000001-gallery",
		);
		expect(await requests[0]?.json()).toEqual({
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			invitationToken: CONNECTION_INVITATION,
		});
		expect(requests[1]?.headers.get("idempotency-key")).toBe("github-run-10000000001");
	});

	it("uploads a built bundle and attestation without a hand-authored release record", async () => {
		const runtime = new FakeRuntime();
		runtime.inputs.delete("release-file");
		runtime.inputs.set("bundle-file", ".emdash-release/gallery.tar.gz");
		runtime.inputs.set("provenance-file", "/runner/temp/attestation.json");
		runtime.environment.set("RUNNER_TEMP", "/runner/temp");
		runtime.environment.set("GITHUB_REPOSITORY", "example/gallery");
		runtime.environment.set(
			"GITHUB_WORKFLOW_REF",
			"example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
		);
		runtime.environment.set("GITHUB_REPOSITORY_VISIBILITY", "public");
		const prepared = preparedFiles();
		const requests: Request[] = [];
		const responses = sequenceFetch([
			success({ status: "connected", policy: policy() }),
			success(
				{
					artifact: {
						slot: "package",
						checksum: CHECKSUM,
						contentType: "application/gzip",
						size: prepared.packageBytes.byteLength,
						sourceUrl: `${SERVICE}/v1/staged-artifacts/package/${CHECKSUM}`,
					},
					replayed: false,
				},
				201,
			),
			success(
				{
					artifact: {
						slot: "provenance",
						checksum: PROVENANCE_CHECKSUM,
						contentType: "application/json",
						size: prepared.provenanceBytes.byteLength,
						sourceUrl: `${SERVICE}/v1/provenance/${PROVENANCE_CHECKSUM}`,
					},
					replayed: false,
				},
				201,
			),
			success({ intent: intent("received"), replayed: false }, 202),
			success({ intent: intent("published", { result: { uri: CREATED_URI, cid: CREATED_CID } }) }),
		]);
		const result = await runAction(runtime, {
			prepareReleaseFiles: async () => prepared,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return responses(input, init);
			},
		});

		expect(result.state).toBe("published");
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v1/workflow-connections",
			"/v1/staged-artifacts",
			"/v1/staged-artifacts",
			"/v1/release-intents",
			`/v1/release-intents/${INTENT_ID}`,
		]);
		const submitted = await requests[3]!.json();
		expect(submitted).toMatchObject({
			release: {
				package: "gallery",
				version: "1.2.3",
				artifacts: {
					package: { url: `${SERVICE}/v1/staged-artifacts/package/${CHECKSUM}` },
				},
				extensions: {
					[NSID.packageReleaseExtension]: {
						provenance: { url: `${SERVICE}/v1/provenance/${PROVENANCE_CHECKSUM}` },
					},
				},
			},
		});
	});

	it("fails before uploading when the package profile needs setup", async () => {
		const runtime = new FakeRuntime();
		runtime.inputs.delete("release-file");
		runtime.inputs.set("bundle-file", ".emdash-release/gallery.tar.gz");
		runtime.inputs.set("provenance-file", "/runner/temp/attestation.json");
		runtime.environment.set("RUNNER_TEMP", "/runner/temp");
		runtime.environment.set("GITHUB_REPOSITORY", "example/gallery");
		runtime.environment.set(
			"GITHUB_WORKFLOW_REF",
			"example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
		);
		runtime.environment.set("GITHUB_REPOSITORY_VISIBILITY", "public");
		const requests: Request[] = [];
		await executeAction(runtime, {
			prepareReleaseFiles: async () => preparedFiles(),
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return failure(
					"PACKAGE_PROFILE_REQUIRED",
					"Create this plugin's package profile with `emdash-plugin profile setup`, then try again",
					409,
				);
			},
		});

		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/v1/workflow-connections",
		]);
		expect(runtime.failures).toEqual([
			"PACKAGE_PROFILE_REQUIRED: Create this plugin's package profile with `emdash-plugin profile setup`, then try again",
		]);
	});

	it("puts first-run workflow approval in the job summary and continues after confirmation", async () => {
		const runtime = new FakeRuntime();
		runtime.inputs.set("poll-interval-seconds", "1");
		const connectionUrl = `${SERVICE}/publisher?connection=${connectionRequest().id}`;
		const result = await runAction(runtime, {
			...dependencies,
			fetch: sequenceFetch([
				success(
					{
						status: "pending",
						request: connectionRequest(),
						approvalUrl: connectionUrl,
						replayed: false,
					},
					202,
				),
				success({ status: "connected", policy: policy() }),
				success({ intent: intent("received"), replayed: false }, 202),
				success({
					intent: intent("published", { result: { uri: CREATED_URI, cid: CREATED_CID } }),
				}),
			]),
		});

		expect(result.state).toBe("published");
		expect(runtime.outputs.get("connection-url")).toBe(connectionUrl);
		expect(runtime.summaries).toEqual([
			`## Approve this GitHub workflow\n\n[Open EmDash to review and approve the workflow](${connectionUrl})`,
		]);
	});

	it("returns the approval URL without failing the job", async () => {
		const runtime = new FakeRuntime();
		const approvalUrl = `${SERVICE}/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const result = await runAction(runtime, {
			...dependencies,
			fetch: sequenceFetch([
				success({ status: "connected", policy: policy() }),
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
				success({ status: "connected", policy: policy() }),
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

	it("rejects blob-bearing source input before requesting OIDC", async () => {
		const runtime = new FakeRuntime();
		const release = sourceRelease();
		Object.assign(release.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		await executeAction(runtime, {
			readReleaseRecord: async () => release,
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});

		expect(runtime.failures).toEqual(["Release record file is invalid"]);
		expect(runtime.tokenCount).toBe(0);
	});
});
