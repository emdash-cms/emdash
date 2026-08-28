import type { StoredSession } from "@atcute/oauth-node-client";
import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { NSID } from "@emdash-cms/registry-lexicons";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { introspectWorkflowInstance, reset, runInDurableObject } from "cloudflare:test";
import { env, type WorkflowStep } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import type ReleaseVerifier from "../../release-verifier/src/index.js";
import { decodeAwaitingApprovalState } from "../src/approvals/digest.js";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import { createPublisherOAuthStores } from "../src/oauth/custody.js";
import { publishVerifiedIntent } from "../src/publishing/workflow.js";
import type { AuthoritativeRecord } from "../src/verification/pds.js";
import {
	restartReleaseIntentWorkflow,
	startReleaseIntentWorkflow,
} from "../src/workflows/start.js";
import { ASSERTION_KEY_2, TEST_BINDINGS } from "./fixtures/oauth.js";
import publicationProofs from "./fixtures/publication-proofs.json";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const CREATED_URI = `at://${PUBLISHER_DID}/${NSID.packageRelease}/gallery:1.2.3`;
const CREATED_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const PACKAGE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
const ARTIFACT_CHECKSUM = "bciqhazpl5w2ra742ngjezwxoy4p74p2eyiftnnhycsofanwmdrezity";
const ARTIFACT_BLOB_CID = "bafkreidqmxv63niqp6ngtesm3lxmoh76h5cmeczwwt4bjhcqg3gbysmuj4";
const DEFAULT_SIGNING_KEY = "zDnaeq9feE9D74uYD5jynoyyQPbhhWU2vStcmC8W1xQHG3fWe";

function writeUint24LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32BigEndian(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
}

function pngBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	writeUint32BigEndian(bytes, 8, 13);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	writeUint32BigEndian(bytes, 16, width);
	writeUint32BigEndian(bytes, 20, height);
	bytes.set([8, 6, 0, 0, 0], 24);
	return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(23);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
	bytes[7] = (height >>> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (width >>> 8) & 0xff;
	bytes[10] = width & 0xff;
	bytes[11] = 3;
	bytes.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 12);
	bytes.set([0xff, 0xd9], 21);
	return bytes;
}

function webpBytes(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(30);
	bytes.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
	bytes.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12);
	writeUint24LittleEndian(bytes, 24, width - 1);
	writeUint24LittleEndian(bytes, 27, height - 1);
	return bytes;
}

async function checksumFor(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error("Unable to compute test checksum");
	return result.value;
}

function encodeBase32(bytes: Uint8Array): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let result = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			result += alphabet[(buffer >>> (bits - 5)) & 31] ?? "";
			bits -= 5;
		}
	}
	if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31] ?? "";
	return result;
}

async function blobCidFor(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const cid = new Uint8Array(4 + digest.byteLength);
	cid.set([0x01, 0x55, 0x12, 0x20]);
	cid.set(digest, 4);
	return `b${encodeBase32(cid)}`;
}
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgDvmOi+nZTPwAHpDNlC2y2J7fUQ1ApZKJRa48jp934NBndmVyc2lvbgHdAQFxEiAO+Y6L6dlM/AAekM2ULbLYnt9RDUClkolFrjyOn3fg0KZjZGlkeB1kaWQ6d2ViOnB1Ymxpc2hlci5leGFtcGxlLmNvbWNyZXZtM211NXFhZHRwazIybWNzaWdYQKq7vfiaEIAWBU/mBxVb+dRselfs/o/vLWgXiiWtBrrBIT9LTKTG8Ylh5LuryHBu1Xx0m0Zu/FeAL7dzSrbBs9tkZGF0YdgqWCUAAXESICPWWGKAvX12s+8YBNB6iLwFl8YMr6smSZpFoaG8aBsnZHByZXb2Z3ZlcnNpb24DkwEBcRIgI9ZYYoC9fXaz7xgE0HqIvAWXxgyvqyZJmkWhobxoGyeiYWWBpGFrWDJjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWFwAGF09mF22CpYJQABcRIg75HAxLI29zFxT2IAMP+6xED3Uxy3mslLTuujJkBV1nphbPbQAwFxEiDvkcDEsjb3MXFPYgAw/7rEQPdTHLeayUtO66MmQFXWeqhiaWR4VWF0Oi8vZGlkOndlYjpwdWJsaXNoZXIuZXhhbXBsZS5jb20vY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlL2dhbGxlcnlkbmFtZWdHYWxsZXJ5ZHR5cGVtZW1kYXNoLXBsdWdpbmUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlZ2F1dGhvcnOBoWRuYW1lcUV4YW1wbGUgUHVibGlzaGVyZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx0c2VjdXJpdHlAZXhhbXBsZS5jb21qZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbqJlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbmpyZXBvc2l0b3J5eCJodHRwczovL2dpdGh1Yi5jb20vZXhhbXBsZS9nYWxsZXJ5";
const APPROVAL_PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgt4Be/ylpOhy2o33XFr7JATwH2VmFRzL6VB4p2I0MSzVndmVyc2lvbgHdAQFxEiC3gF7/KWk6HLajfdcWvskBPAfZWYVHMvpUHinYjQxLNaZjZGlkeB1kaWQ6d2ViOnB1Ymxpc2hlci5leGFtcGxlLmNvbWNyZXZtM211NXFhZHR6Y2sybWNzaWdYQBg2vVFiuGjkb1Q9TukMNZFbFZ/xXo5d8a6UZnGNnq/FIGQMPMH+RiEl+yhSvATZ9KnIQ2ujZ5q5qkjKyu5t6XhkZGF0YdgqWCUAAXESIGduRlvZ/Lua96nilhYmPVcpLg+ZjEa4kIialhQmHwB0ZHByZXb2Z3ZlcnNpb24DkwEBcRIgZ25GW9n8u5r3qeKWFiY9VykuD5mMRriQiJqWFCYfAHSiYWWBpGFrWDJjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWFwAGF09mF22CpYJQABcRIgrKiSWBl9zSDvo1PXTnK3qUZGccnZeweHtjm0xemh2J5hbPaPBAFxEiCsqJJYGX3NIO+jU9dOcrepRkZxydl7B4e2ObTF6aHYnqhiaWR4VWF0Oi8vZGlkOndlYjpwdWJsaXNoZXIuZXhhbXBsZS5jb20vY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlL2dhbGxlcnlkbmFtZWdHYWxsZXJ5ZHR5cGVtZW1kYXNoLXBsdWdpbmUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlZ2F1dGhvcnOBoWRuYW1lcUV4YW1wbGUgUHVibGlzaGVyZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx0c2VjdXJpdHlAZXhhbXBsZS5jb21qZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbqNlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbmpyZXBvc2l0b3J5eCJodHRwczovL2dpdGh1Yi5jb20vZXhhbXBsZS9nYWxsZXJ5bXJlbGVhc2VQb2xpY3miaWFwcHJvdmVyc4FwZGlkOnBsYzphcHByb3Zlcmxjb25maXJtYXRpb25mYWx3YXlz";
const PROVENANCE = {
	predicateType: "https://slsa.dev/provenance/v1",
	url: "https://github.com/example/gallery/attestation.sigstore.json",
	checksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	sourceRepository: "https://github.com/example/gallery",
	builderId: "https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
} as const;
const CONTROL_ACTOR = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
} as const;
async function createDpopKey(): Promise<StoredSession["dpopKey"]> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
		"sign",
		"verify",
	]);
	if (!("privateKey" in pair)) throw new Error("Failed to generate DPoP test key pair");
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	if (
		jwk instanceof ArrayBuffer ||
		jwk.kty !== "EC" ||
		jwk.crv !== "P-256" ||
		typeof jwk.x !== "string" ||
		typeof jwk.y !== "string" ||
		typeof jwk.d !== "string"
	) {
		throw new Error("Failed to generate DPoP test key");
	}
	return { kty: "EC", crv: "P-256", alg: "ES256", x: jwk.x, y: jwk.y, d: jwk.d };
}

async function storeDelegation() {
	const configuration = await loadConfiguration(TEST_BINDINGS);
	const custody = createPublisherOAuthStores(
		env.PUBLISHER_DO,
		configuration.encryption,
		configuration.oauth,
		{
			purpose: "release_delegation",
			expectedDid: PUBLISHER_DID,
			redirectTarget: "/",
		},
	);
	await custody.stores.sessions.set(PUBLISHER_DID, {
		dpopKey: await createDpopKey(),
		authMethod: { method: "private_key_jwt", kid: ASSERTION_KEY_2.kid },
		tokenSet: {
			iss: "https://authorization.example",
			sub: PUBLISHER_DID,
			aud: "https://pds.example.com",
			scope: configuration.oauth.releaseScope,
			access_token: "access-token",
			refresh_token: "refresh-token",
			token_type: "DPoP",
			expires_at: Date.now() + 60 * 60_000,
		},
	});
}

function releaseRecord() {
	const release = structuredClone(releaseFixture) as PackageRelease.Main & {
		extensions: Record<
			string,
			{ declaredAccess: Record<string, unknown>; provenance?: typeof PROVENANCE }
		>;
	};
	release.artifacts.package.checksum = ARTIFACT_CHECKSUM;
	release.extensions[NSID.packageReleaseExtension]!.provenance = PROVENANCE;
	return release;
}

async function fullReleaseRecord() {
	const release = releaseRecord();
	const icon = pngBytes(128, 128);
	const banner = jpegBytes(1200, 400);
	const desktop = webpBytes(1440, 900);
	const mobile = pngBytes(390, 844);
	release.artifacts = {
		package: {
			url: "https://github.com/example/gallery/releases/download/v1.2.3/gallery.tar.gz",
			checksum: ARTIFACT_CHECKSUM,
			releaseAsset: true,
		},
		icon: {
			url: "https://assets.example/icon.png",
			checksum: await checksumFor(icon),
			id: "icon",
		},
		banner: {
			url: "https://assets.example/banner.jpg",
			checksum: await checksumFor(banner),
		},
		screenshots: [
			{
				url: "https://assets.example/desktop.webp",
				checksum: await checksumFor(desktop),
				id: "desktop",
				lang: "en",
			},
			{
				url: "https://assets.example/mobile.png",
				checksum: await checksumFor(mobile),
				id: "mobile",
			},
		],
	};
	return {
		release,
		sources: new Map([
			["https://assets.example/icon.png", { bytes: icon, mimeType: "image/png" }],
			["https://assets.example/banner.jpg", { bytes: banner, mimeType: "image/jpeg" }],
			["https://assets.example/desktop.webp", { bytes: desktop, mimeType: "image/webp" }],
			["https://assets.example/mobile.png", { bytes: mobile, mimeType: "image/png" }],
		]),
	};
}

function proofBytes(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

interface WorkflowNetworkOptions {
	artifactSources?: ReadonlyMap<string, { bytes: Uint8Array; mimeType: string }>;
	profileProof?: string;
	listedReleases?: () => readonly AuthoritativeRecord[];
	authoritativeProof?: () => Uint8Array | null;
	signingKey?: () => string;
	onArtifactFetch?: () => Response | void | Promise<Response | void>;
	onAuthorizationMetadata?: () => void | Promise<void>;
	onUploadBlob?: (request: Request) => Response | void | Promise<Response | void>;
	onCreateRecord?: (request: Request) => Response | Promise<Response>;
}

function workflowNetwork(options: WorkflowNetworkOptions = {}) {
	const profileProof = options.profileProof ?? PROFILE_PROOF;
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
			});
		}
		if (url.hostname === "publisher.example.com" && url.pathname === "/.well-known/did.json") {
			return Response.json({
				id: PUBLISHER_DID,
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: options.signingKey?.() ?? DEFAULT_SIGNING_KEY,
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			});
		}
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			if (url.searchParams.get("collection") === NSID.packageRelease) {
				const proof = options.authoritativeProof?.() ?? null;
				return proof
					? new Response(proof, {
							headers: { "content-type": "application/vnd.ipld.car" },
						})
					: Response.json({ error: "RecordNotFound" }, { status: 404 });
			}
			return new Response(
				Uint8Array.from(atob(profileProof), (character) => character.charCodeAt(0)),
				{ headers: { "content-type": "application/vnd.ipld.car" } },
			);
		}
		if (
			url.hostname === "pds.example.com" &&
			url.pathname === "/.well-known/oauth-protected-resource"
		) {
			return Response.json({
				resource: "https://pds.example.com",
				authorization_servers: ["https://authorization.example"],
			});
		}
		if (
			url.hostname === "authorization.example" &&
			url.pathname === "/.well-known/oauth-authorization-server"
		) {
			await options.onAuthorizationMetadata?.();
			return Response.json({
				issuer: "https://authorization.example",
				authorization_endpoint: "https://authorization.example/authorize",
				token_endpoint: "https://authorization.example/token",
				pushed_authorization_request_endpoint: "https://authorization.example/par",
				client_id_metadata_document_supported: true,
				dpop_signing_alg_values_supported: ["ES256"],
				response_types_supported: ["code"],
				authorization_response_iss_parameter_supported: true,
			});
		}
		if (
			url.hostname === "github.com" &&
			url.pathname === "/example/gallery/releases/download/v1.2.3/gallery.tar.gz"
		) {
			const response = await options.onArtifactFetch?.();
			if (response) return response;
			return new Response(PACKAGE_BYTES, { headers: { "content-type": "application/gzip" } });
		}
		const artifactSource = options.artifactSources?.get(url.toString());
		if (artifactSource) {
			return new Response(artifactSource.bytes, {
				headers: { "content-type": artifactSource.mimeType },
			});
		}
		if (
			url.hostname === "pds.example.com" &&
			url.pathname === "/xrpc/com.atproto.repo.uploadBlob"
		) {
			const request = input instanceof Request ? input : new Request(url, init);
			const response = await options.onUploadBlob?.(request);
			if (response) return response;
			return Response.json({
				blob: {
					$type: "blob",
					ref: { $link: ARTIFACT_BLOB_CID },
					mimeType: "application/gzip",
					size: PACKAGE_BYTES.byteLength,
				},
			});
		}
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			const collection = url.searchParams.get("collection");
			if (collection === NSID.packageRelease) {
				expect(url.searchParams.get("rkey")).toBe("gallery:1.2.3");
				return options.authoritativeProof?.()
					? Response.json({ uri: CREATED_URI, cid: CREATED_CID, value: {} })
					: Response.json({ error: "RecordNotFound" }, { status: 400 });
			}
		}
		if (
			url.hostname === "pds.example.com" &&
			url.pathname === "/xrpc/com.atproto.repo.listRecords"
		) {
			return Response.json({ records: options.listedReleases?.() ?? [] });
		}
		if (
			url.hostname === "pds.example.com" &&
			url.pathname === "/xrpc/com.atproto.repo.createRecord"
		) {
			const request = input instanceof Request ? input : new Request(url, init);
			if (options.onCreateRecord) return options.onCreateRecord(request);
			return Response.json({
				uri: CREATED_URI,
				cid: CREATED_CID,
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

async function createVerifyingIntent(
	transitionToVerifying = true,
	releaseInputJson = JSON.stringify({ release: releaseRecord() }),
) {
	const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
	await publisher.putWorkloadPolicy({
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW,
	});
	await publisher.createIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify({ issuer: "github-actions", runId: "100" }),
		releaseInputJson,
		expiresAt: NOW + 60_000,
		now: NOW + 1,
	});
	await storeDelegation();
	if (!transitionToVerifying) return;
	await publisher.transitionIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		expectedState: "received",
		expectedGeneration: 1,
		toState: "verifying",
		transitionDigest: "C".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: "{}",
		workflowId: INTENT_ID,
		now: NOW + 2,
	});
}

function immediateWorkflowStep(): WorkflowStep {
	return {
		do: async (...args: unknown[]) => {
			const callback: unknown = args.findLast((value) => typeof value === "function");
			if (typeof callback !== "function") throw new Error("Workflow step callback is missing");
			const result: unknown = await callback();
			return result;
		},
	} as WorkflowStep;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await reset();
});

describe("ReleaseIntentWorkflow", () => {
	it("fails the intent when a verification step conflicts", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putVerificationStep({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			name: "authoritative-profile",
			inputDigest: "Z".repeat(43),
			resultJson: '{"profileCid":"conflicting"}',
		});
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("errored");

		await expect(publisher.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "failed",
			stateDataJson: '{"code":"VERIFICATION_STEP_CONFLICT"}',
		});
	});

	it("fails the intent when the verifier input is invalid", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent(true, "{}");
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("errored");

		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			state: "failed",
			stateDataJson: '{"code":"VERIFIER_INPUT_INVALID"}',
		});
	});

	it("persists every verification stage and publishes a valid non-escalating intent", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "published",
			reasonCode: null,
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "published", stateGeneration: 6 });
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).listVerificationSteps(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject([
			{ name: "authoritative-profile" },
			{ name: "release-absence" },
			{ name: "access-baseline" },
			{ name: "artifact-provenance" },
			{ name: "policy-decision" },
			{ name: "final-verification" },
		]);
	});

	it("uploads every artifact before permitting a blob-only canonical create", async () => {
		const full = await fullReleaseRecord();
		const events: string[] = [];
		const uploadSlots = ["package", "icon", "banner", "screenshots[0]", "screenshots[1]"];
		let uploadIndex = 0;
		const createdRecords: PackageRelease.Main[] = [];
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				artifactSources: full.sources,
				onUploadBlob: async (request) => {
					const bytes = new Uint8Array(await request.arrayBuffer());
					const mimeType = request.headers.get("content-type");
					if (!mimeType) throw new Error("Expected upload MIME type");
					const slot = uploadSlots[uploadIndex];
					if (!slot) throw new Error("Unexpected extra upload");
					uploadIndex += 1;
					events.push(`upload:${slot}`);
					return Response.json({
						blob: {
							$type: "blob",
							ref: { $link: await blobCidFor(bytes) },
							mimeType,
							size: bytes.byteLength,
						},
					});
				},
				onCreateRecord: async (request) => {
					const materialization = await env.PUBLISHER_DO.getByName(
						PUBLISHER_DID,
					).getPublicationMaterialization(PUBLISHER_DID, INTENT_ID);
					expect(materialization?.status).toBe("complete");
					events.push("materialized");
					events.push("permit:issued", "permit:consumed", "create");
					const body = await request.json<{ record: PackageRelease.Main }>();
					createdRecords.push(body.record);
					return Response.json({ uri: CREATED_URI, cid: CREATED_CID });
				},
			}),
		);
		await createVerifyingIntent(true, JSON.stringify({ release: full.release }));
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		expect(events).toEqual([
			"upload:package",
			"upload:icon",
			"upload:banner",
			"upload:screenshots[0]",
			"upload:screenshots[1]",
			"materialized",
			"permit:issued",
			"permit:consumed",
			"create",
		]);
		const createdRecord = createdRecords[0];
		if (!createdRecord) throw new Error("Expected created release record");
		expect(createdRecord).toMatchObject({
			artifacts: {
				package: { contentType: "application/gzip", blob: { mimeType: "application/gzip" } },
				icon: { contentType: "image/png", width: 128, height: 128 },
				banner: { contentType: "image/jpeg", width: 1200, height: 400 },
				screenshots: [
					{ contentType: "image/webp", width: 1440, height: 900 },
					{ contentType: "image/png", width: 390, height: 844 },
				],
			},
		});
		for (const artifact of [
			createdRecord.artifacts.package,
			createdRecord.artifacts.icon,
			createdRecord.artifacts.banner,
			...(createdRecord.artifacts.screenshots ?? []),
		]) {
			expect(artifact).toHaveProperty("blob");
			expect(artifact).not.toHaveProperty("url");
			expect(artifact).not.toHaveProperty("releaseAsset");
			expect(artifact).not.toHaveProperty("requiresAuth");
		}
		const materialization = await publisher.getPublicationMaterialization(PUBLISHER_DID, INTENT_ID);
		if (!materialization) throw new Error("Expected materialization state");
		const latestUpload = Math.max(
			...materialization.slots.map((artifact) => artifact.uploadedAt ?? 0),
		);
		const permit = await runInDurableObject(control, (_instance, state) =>
			state.storage.sql
				.exec<{ consumed_at: number; created_at: number }>(
					"SELECT created_at, consumed_at FROM publication_permits",
				)
				.one(),
		);
		expect(permit.created_at).toBeGreaterThanOrEqual(latestUpload);
		expect(permit.created_at).toBeGreaterThanOrEqual(materialization.updatedAt);
		expect(permit.consumed_at).toBeGreaterThanOrEqual(permit.created_at);
		const operation = await runInDurableObject(publisher, (_instance, state) =>
			state.storage.sql
				.exec<{ phase: string }>(
					"SELECT phase FROM publication_operations WHERE intent_id = ?",
					INTENT_ID,
				)
				.one(),
		);
		expect(operation.phase).toBe("creating");
		await expect(env.PUBLICATION_STAGING.list()).resolves.toMatchObject({ objects: [] });
	}, 15_000);

	it("retries an ambiguous blob upload without entering release reconciliation", async () => {
		let uploadAttempts = 0;
		let createAttempts = 0;
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				onUploadBlob: () => {
					uploadAttempts += 1;
					if (uploadAttempts === 1) throw new Error("Simulated lost upload response");
				},
				onCreateRecord: () => {
					createAttempts += 1;
					return Response.json({ uri: CREATED_URI, cid: CREATED_CID });
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		expect(uploadAttempts).toBe(2);
		expect(createAttempts).toBe(1);
		await expect(introspector.getOutput()).resolves.toMatchObject({ state: "published" });
		const operation = await runInDurableObject(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID),
			(_instance, state) =>
				state.storage.sql
					.exec<{ outcome: string; phase: string }>(
						"SELECT outcome, phase FROM publication_operations WHERE intent_id = ?",
						INTENT_ID,
					)
					.one(),
		);
		expect(operation).toEqual({ outcome: "published", phase: "creating" });
	}, 10_000);

	it("converges a timeout after createRecord to the exact authoritative release", async () => {
		let createAttempts = 0;
		let authoritativeVisible = false;
		const authoritative = {
			proof: proofBytes(publicationProofs.exactProof),
			signingKey: publicationProofs.signingKey,
		};
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				authoritativeProof: () => (authoritativeVisible ? authoritative.proof : null),
				signingKey: () => (authoritativeVisible ? authoritative.signingKey : DEFAULT_SIGNING_KEY),
				onCreateRecord: () => {
					createAttempts += 1;
					authoritativeVisible = true;
					throw new Error("Simulated timeout after the PDS committed the record");
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "published",
			reasonCode: null,
		});
		expect(createAttempts).toBe(1);
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "published", stateGeneration: 7 });
	});

	it("makes a different record at the deterministic key a terminal conflict", async () => {
		let createAttempts = 0;
		let authoritativeVisible = false;
		const authoritative = {
			proof: proofBytes(publicationProofs.conflictProof),
			signingKey: publicationProofs.signingKey,
		};
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				authoritativeProof: () => (authoritativeVisible ? authoritative.proof : null),
				signingKey: () => (authoritativeVisible ? authoritative.signingKey : DEFAULT_SIGNING_KEY),
				onCreateRecord: () => {
					createAttempts += 1;
					authoritativeVisible = true;
					throw new Error("Simulated ambiguous create response");
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "conflict",
			reasonCode: "RELEASE_CONFLICT",
		});
		expect(createAttempts).toBe(1);
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "conflict", stateGeneration: 7 });
	});

	it("makes a release that appears before final verification a terminal conflict", async () => {
		let snapshotReads = 0;
		let createAttempts = 0;
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				listedReleases: () => {
					snapshotReads += 1;
					return snapshotReads < 4
						? []
						: [{ uri: CREATED_URI, cid: CREATED_CID, value: releaseRecord() }];
				},
				onCreateRecord: () => {
					createAttempts += 1;
					return Response.json({ uri: CREATED_URI, cid: CREATED_CID });
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "conflict",
			reasonCode: "RELEASE_EXISTS",
		});
		expect(createAttempts).toBe(0);
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "conflict" });
	}, 15_000);

	it("invalidates an intent when the final publisher snapshot is malformed", async () => {
		let snapshotReads = 0;
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				listedReleases: () => {
					snapshotReads += 1;
					return snapshotReads < 4
						? []
						: [{ uri: "not-an-at-uri", cid: CREATED_CID, value: releaseRecord() }];
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "invalid",
			reasonCode: "RELEASE_LIST_INVALID",
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "invalid" });
	}, 15_000);

	it("uses a fresh permit and publication generation after each confirmed absence", async () => {
		let createAttempts = 0;
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				onCreateRecord: () => {
					createAttempts += 1;
					throw new Error("Simulated timeout before the PDS committed the record");
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "failed",
			reasonCode: "PDS_RETRY_EXHAUSTED",
		});
		expect(createAttempts).toBe(3);
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "failed", stateGeneration: 13 });

		const operation = await runInDurableObject(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID),
			(_instance, state) =>
				state.storage.sql
					.exec<{ generation: number; outcome: string; status: string }>(
						"SELECT generation, outcome, status FROM publication_operations WHERE intent_id = ?",
						INTENT_ID,
					)
					.one(),
		);
		expect(operation).toEqual({ generation: 3, outcome: "ambiguous", status: "completed" });
		const permits = await runInDurableObject(
			env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME),
			(_instance, state) =>
				state.storage.sql
					.exec<{ consumed: number; distinct_ids: number; total: number }>(
						`SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distinct_ids,
						        SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
						 FROM publication_permits`,
					)
					.one(),
		);
		expect(permits).toEqual({ total: 3, distinct_ids: 3, consumed: 3 });
	});

	it.each([
		["publication pause", "pause", "ready", "PUBLICATION_PAUSED"],
		["publisher suspension", "suspend", "ready", "PUBLISHER_SUSPENDED"],
		["delegation revocation", "revoke", "failed", "OAUTH_DELEGATION_UNAVAILABLE"],
	] as const)(
		"blocks publication after a permit when %s wins the pre-write race",
		async (_name, controlAction, expectedState, expectedReason) => {
			let controlApplied = false;
			let createAttempts = 0;
			vi.stubGlobal(
				"fetch",
				workflowNetwork({
					onAuthorizationMetadata: async () => {
						if (controlApplied) return;
						controlApplied = true;
						if (controlAction === "revoke") {
							const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
							const delegation = await publisher.getDelegation(PUBLISHER_DID);
							if (!delegation) throw new Error("Expected stored delegation");
							await publisher.revokeDelegation(PUBLISHER_DID, delegation.stateVersion);
							return;
						}
						const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
						if (controlAction === "pause") {
							await control.setServiceMode({
								actor: CONTROL_ACTOR,
								idempotencyKey: "publication-pause-test",
								requestDigest: "P".repeat(43),
								mode: "publication-paused",
								reasonCode: "TEST_PAUSE",
							});
							return;
						}
						await control.setPublisherControl({
							actor: CONTROL_ACTOR,
							idempotencyKey: "publisher-suspend-test",
							requestDigest: "S".repeat(43),
							publisherDid: PUBLISHER_DID,
							status: "suspended",
							reasonCode: "TEST_SUSPEND",
						});
					},
					onCreateRecord: () => {
						createAttempts += 1;
						return Response.json({ uri: CREATED_URI, cid: CREATED_CID });
					},
				}),
			);
			await createVerifyingIntent();
			await using introspector = await introspectWorkflowInstance(
				env.RELEASE_INTENT_WORKFLOW,
				INTENT_ID,
			);
			await env.RELEASE_INTENT_WORKFLOW.create({
				id: INTENT_ID,
				params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
			});
			await introspector.waitForStatus("complete");

			await expect(introspector.getOutput()).resolves.toEqual({
				intentId: INTENT_ID,
				state: expectedState,
				reasonCode: expectedReason,
			});
			expect(createAttempts).toBe(0);
			await expect(
				env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
			).resolves.toMatchObject({ state: expectedState });
		},
	);

	it("restarts a completed ready Workflow after publication is unpaused", async () => {
		let paused = false;
		let createAttempts = 0;
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				onAuthorizationMetadata: async () => {
					if (paused) return;
					paused = true;
					await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setServiceMode({
						actor: CONTROL_ACTOR,
						idempotencyKey: "publication-restart-pause",
						requestDigest: "R".repeat(43),
						mode: "publication-paused",
						reasonCode: "TEST_PAUSE",
					});
				},
				onCreateRecord: () => {
					createAttempts += 1;
					return Response.json({ uri: CREATED_URI, cid: CREATED_CID });
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");
		await expect(introspector.getOutput()).resolves.toMatchObject({ state: "ready" });

		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setServiceMode({
			actor: CONTROL_ACTOR,
			idempotencyKey: "publication-restart-active",
			requestDigest: "A".repeat(43),
			mode: "active",
			reasonCode: null,
		});
		await expect(
			restartReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, restarted: true });
		await introspector.waitForStepResult({ name: "recovery-policy-decision" });
		await introspector.waitForStatus("complete");
		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "published",
			reasonCode: null,
		});
		expect(createAttempts).toBe(1);
	});

	it("resumes publication when the publishing transition committed without an operation", async () => {
		vi.stubGlobal("fetch", workflowNetwork({ profileProof: APPROVAL_PROFILE_PROOF }));
		await createVerifyingIntent();
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		const originalIntent = await publisher.getIntent(PUBLISHER_DID, INTENT_ID);
		if (!originalIntent) throw new Error("Expected a stored intent");
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStepResult({ name: "await-approval" });
		const awaiting = await publisher.getIntent(PUBLISHER_DID, INTENT_ID);
		if (!awaiting) throw new Error("Expected an awaiting intent");
		const approval = await decodeAwaitingApprovalState(awaiting.stateDataJson);
		const ready = await publisher.transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "awaiting_approval",
			expectedGeneration: awaiting.stateGeneration,
			toState: "ready",
			transitionDigest: "Y".repeat(43),
			actorRealm: "approver",
			actorIdentity: "did:plc:approver",
			reasonCode: "APPROVED",
			stateDataJson: JSON.stringify({ approved: true }),
		});
		expect(ready.ok).toBe(true);
		if (!ready.ok) return;
		await publisher.transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "ready",
			expectedGeneration: ready.intent.stateGeneration,
			toState: "publishing",
			transitionDigest: "X".repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: JSON.stringify({ attempt: 1 }),
		});
		const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
		await control.setServiceMode({
			actor: CONTROL_ACTOR,
			idempotencyKey: "publishing-retry-paused",
			requestDigest: "V".repeat(43),
			mode: "publication-paused",
			reasonCode: "TEST_PAUSE",
		});

		await expect(
			publishVerifiedIntent(
				{
					...env,
					RELEASE_VERIFIER: env.RELEASE_VERIFIER as Service<typeof ReleaseVerifier>,
				},
				immediateWorkflowStep(),
				PUBLISHER_DID,
				originalIntent,
				approval.approvalEvidence,
			),
		).resolves.toEqual({
			intentId: INTENT_ID,
			state: "ready",
			reasonCode: "PUBLICATION_PAUSED",
		});
		await expect(publisher.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "ready",
		});
		await control.setServiceMode({
			actor: CONTROL_ACTOR,
			idempotencyKey: "publishing-retry-active",
			requestDigest: "U".repeat(43),
			mode: "active",
			reasonCode: null,
		});
		await expect(
			publishVerifiedIntent(
				{
					...env,
					RELEASE_VERIFIER: env.RELEASE_VERIFIER as Service<typeof ReleaseVerifier>,
				},
				immediateWorkflowStep(),
				PUBLISHER_DID,
				originalIntent,
				approval.approvalEvidence,
			),
		).resolves.toEqual({ intentId: INTENT_ID, state: "published", reasonCode: null });
		await expect(publisher.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "published",
		});
		const operation = await runInDurableObject(publisher, (_instance, state) =>
			state.storage.sql
				.exec<{ lease_ms: number }>(
					`SELECT expires_at - started_at AS lease_ms
					 FROM publication_operations WHERE intent_id = ?`,
					INTENT_ID,
				)
				.one(),
		);
		expect(operation.lease_ms).toBe(5 * 60_000);
	});

	it("restarts an errored reconciliation and accepts the exact authoritative record", async () => {
		let reconciliationAvailable = false;
		let sourceAvailable = true;
		let sourceFetches = 0;
		let createAttempts = 0;
		let authoritativeVisible = false;
		const authoritative = {
			proof: proofBytes(publicationProofs.exactProof),
			signingKey: publicationProofs.signingKey,
		};
		vi.stubGlobal(
			"fetch",
			workflowNetwork({
				authoritativeProof: () => {
					if (!reconciliationAvailable) throw new Error("Simulated PDS read outage");
					return authoritativeVisible ? authoritative.proof : null;
				},
				signingKey: () => (authoritativeVisible ? authoritative.signingKey : DEFAULT_SIGNING_KEY),
				onArtifactFetch: () => {
					sourceFetches += 1;
					return sourceAvailable ? undefined : new Response(null, { status: 503 });
				},
				onCreateRecord: () => {
					createAttempts += 1;
					authoritativeVisible = true;
					throw new Error("Simulated timeout after commit");
				},
			}),
		);
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("errored");
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "reconciling" });

		reconciliationAvailable = true;
		sourceAvailable = false;
		await expect(
			restartReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, restarted: true });
		await introspector.waitForStepResult({ name: "recovery-reconciliation" });
		await introspector.waitForStatus("complete");
		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "published",
			reasonCode: null,
		});
		expect(createAttempts).toBe(1);
		expect(sourceFetches).toBe(1);
	}, 15_000);

	it("waits for a canonical approval transition and resumes from its event", async () => {
		vi.stubGlobal("fetch", workflowNetwork({ profileProof: APPROVAL_PROFILE_PROOF }));
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await introspector.modify((modifier) =>
			modifier.forceEventTimeout({ name: "approval-decision" }),
		);
		const instance = await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStepResult({ name: "await-approval" });
		await introspector.waitForStepResult({ name: "approval-timeout-state" });
		const awaiting = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(
			PUBLISHER_DID,
			INTENT_ID,
		);
		expect(awaiting).toMatchObject({ state: "awaiting_approval", stateGeneration: 4 });
		if (!awaiting) throw new Error("Expected awaiting intent");
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "awaiting_approval",
			expectedGeneration: awaiting.stateGeneration,
			toState: "ready",
			transitionDigest: "Z".repeat(43),
			actorRealm: "approver",
			actorIdentity: "did:plc:approver",
			reasonCode: "APPROVED",
			stateDataJson: JSON.stringify({ approved: true }),
		});
		await instance.sendEvent({ type: "approval-decision", payload: { decision: "approve" } });
		await introspector.waitForStatus("complete");
		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "published",
			reasonCode: null,
		});
	});

	it("starts one deterministic Workflow instance and reuses it on replay", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent(false);
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);

		await expect(
			startReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, created: true });
		await introspector.waitForStatus("complete");
		await expect(
			startReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, created: false });
	});

	it("persists a verifier rejection and terminates the intent as invalid", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await introspector.modify(async (modifier) => {
			await modifier.mockStepResult(
				{ name: "isolated-verifier" },
				JSON.stringify({
					success: false,
					error: { code: "CHECKSUM_MISMATCH", message: "Artifact verification failed" },
				}),
			);
		});
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "invalid",
			reasonCode: "CHECKSUM_MISMATCH",
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "invalid" });
	});
});
