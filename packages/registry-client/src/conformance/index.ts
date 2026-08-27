/**
 * Exact-scope PDS conformance probes for delegated release publishing.
 *
 * The caller supplies an authenticated AT Protocol handler. This module does
 * not acquire or persist credentials, which lets the same probes run through
 * the CLI's loopback client and the release service's confidential client.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-named-blocks, eslint-plugin-import/no-empty-named-blocks, eslint-plugin-unicorn/require-module-specifiers, import/no-empty-named-blocks, unicorn/require-module-specifiers
import type {} from "@atcute/atproto";
import {
	Client,
	ClientResponseError,
	type FetchHandler,
	type FetchHandlerObject,
	ok,
} from "@atcute/client";
import { NSID, getDelegatedReleasePermission } from "@emdash-cms/registry-lexicons";

import type { Did } from "../credentials/types.js";

const RUN_ID_PATTERN = /^[a-z0-9]{6,32}$/;
const CONFORMANCE_PACKAGE = "emdash_g0_conformance";
const UNRELATED_COLLECTION = "com.emdashcms.experimental.conformance.probe";

export type PdsProbeExpectation = "allow" | "deny";
export type PdsProbeOutcome = "allowed" | "denied" | "error";

export interface PdsConformanceProbe {
	id: string;
	expectation: PdsProbeExpectation;
	outcome: PdsProbeOutcome;
	passed: boolean;
	status?: number;
	error?: string;
	description?: string;
	uri?: string;
	cid?: string;
}

export interface PdsScopeConformanceReport {
	version: 1;
	provider: string;
	did: Did;
	pds: string;
	runId: string;
	requestedScope: string;
	release: {
		collection: string;
		rkey: string;
		package: string;
		version: string;
	};
	probes: PdsConformanceProbe[];
	passed: boolean;
}

export interface RunPdsScopeConformanceOptions {
	handler: FetchHandler | FetchHandlerObject;
	did: Did;
	pds: string;
	provider: string;
	runId: string;
}

interface ProbeValue {
	uri?: string;
	cid?: string;
}

function expectedDenial(error: ClientResponseError): boolean {
	return error.status >= 400 && error.status < 500;
}

async function probe(
	id: string,
	expectation: PdsProbeExpectation,
	operation: () => Promise<ProbeValue | void>,
): Promise<PdsConformanceProbe> {
	try {
		const value = await operation();
		return {
			id,
			expectation,
			outcome: "allowed",
			passed: expectation === "allow",
			...(value?.uri ? { uri: value.uri } : {}),
			...(value?.cid ? { cid: value.cid } : {}),
		};
	} catch (error) {
		if (error instanceof ClientResponseError) {
			const denied = expectedDenial(error);
			return {
				id,
				expectation,
				outcome: denied ? "denied" : "error",
				passed: expectation === "deny" && denied,
				status: error.status,
				error: error.error,
				...(error.description ? { description: error.description } : {}),
			};
		}
		return {
			id,
			expectation,
			outcome: "error",
			passed: false,
			error: error instanceof Error ? error.name : "UnknownError",
			description: error instanceof Error ? error.message : "The probe failed unexpectedly.",
		};
	}
}

function releaseRecord(version: string, runId: string): Record<string, unknown> {
	return {
		$type: NSID.packageRelease,
		package: CONFORMANCE_PACKAGE,
		version,
		artifacts: {
			package: {
				url: `https://example.invalid/emdash-g0/${runId}.tar.gz`,
				checksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			},
		},
	};
}

/**
 * Exercise the authority granted to an authenticated session.
 *
 * A successful run leaves one release record in the dedicated conformance
 * account. Deletion is an expected denial and the record is retained as the
 * evidence of the create-only grant.
 */
export async function runPdsScopeConformance(
	options: RunPdsScopeConformanceOptions,
): Promise<PdsScopeConformanceReport> {
	if (!RUN_ID_PATTERN.test(options.runId)) {
		throw new TypeError("runId must contain 6-32 lowercase ASCII letters or digits");
	}
	const client = new Client({ handler: options.handler });
	const permission = getDelegatedReleasePermission();
	const version = `0.0.0-g0.${options.runId}`;
	const rkey = `${CONFORMANCE_PACKAGE}:${version}`;
	const record = releaseRecord(version, options.runId);
	const updatedRecord = {
		...record,
		repo: `https://example.invalid/changed/${options.runId}`,
	};
	const profileRkey = `emdash_g0_profile_${options.runId}`;
	const unrelatedRkey = `g0_${options.runId}`;

	const probes: PdsConformanceProbe[] = [];
	probes.push(
		await probe("release-create", "allow", async () => {
			const result = await ok(
				client.post("com.atproto.repo.createRecord", {
					input: {
						repo: options.did,
						collection: permission.collection,
						rkey,
						record,
						validate: false,
					},
				}),
			);
			return { uri: result.uri, cid: result.cid };
		}),
	);
	probes.push(
		await probe("release-readback", "allow", async () => {
			const result = await ok(
				client.get("com.atproto.repo.getRecord", {
					params: { repo: options.did, collection: permission.collection, rkey },
				}),
			);
			return { uri: result.uri, ...(result.cid ? { cid: result.cid } : {}) };
		}),
	);
	probes.push(
		await probe("release-update", "deny", async () => {
			const result = await ok(
				client.post("com.atproto.repo.putRecord", {
					input: {
						repo: options.did,
						collection: permission.collection,
						rkey,
						record: updatedRecord,
						validate: false,
					},
				}),
			);
			return { uri: result.uri, cid: result.cid };
		}),
	);
	probes.push(
		await probe("release-delete", "deny", async () => {
			await ok(
				client.post("com.atproto.repo.deleteRecord", {
					input: { repo: options.did, collection: permission.collection, rkey },
				}),
			);
		}),
	);
	probes.push(
		await probe("profile-create", "deny", async () => {
			const result = await ok(
				client.post("com.atproto.repo.createRecord", {
					input: {
						repo: options.did,
						collection: NSID.packageProfile,
						rkey: profileRkey,
						record: {
							$type: NSID.packageProfile,
							id: `at://${options.did}/${NSID.packageProfile}/${profileRkey}`,
							type: "emdash-plugin",
							license: "MIT",
							authors: [{ name: "EmDash G0 conformance" }],
							security: [{ url: "https://example.invalid/security" }],
						},
						validate: false,
					},
				}),
			);
			return { uri: result.uri, cid: result.cid };
		}),
	);
	probes.push(
		await probe("unrelated-create", "deny", async () => {
			const result = await ok(
				client.post("com.atproto.repo.createRecord", {
					input: {
						repo: options.did,
						collection: UNRELATED_COLLECTION,
						rkey: unrelatedRkey,
						record: { $type: UNRELATED_COLLECTION, runId: options.runId },
						validate: false,
					},
				}),
			);
			return { uri: result.uri, cid: result.cid };
		}),
	);

	return {
		version: 1,
		provider: options.provider,
		did: options.did,
		pds: options.pds,
		runId: options.runId,
		requestedScope: permission.scope,
		release: {
			collection: permission.collection,
			rkey,
			package: CONFORMANCE_PACKAGE,
			version,
		},
		probes,
		passed: probes.every((item) => item.passed),
	};
}
