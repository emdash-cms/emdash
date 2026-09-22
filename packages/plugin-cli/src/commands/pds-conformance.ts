/**
 * Engineering command for G0 delegated-release PDS conformance.
 *
 * It deliberately requests only the exact delegated release scope, whose
 * repository permission is limited to creating release records, and
 * never retries with `transition:generic`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { isDid } from "@atcute/lexicons/syntax";
import type { OAuthSession } from "@atcute/oauth-node-client";
import {
	runPdsScopeConformance,
	type PdsScopeDenialExpectation,
} from "@emdash-cms/registry-client/internal/conformance";
import { getDelegatedReleasePermission } from "@emdash-cms/registry-lexicons";
import { defineCommand } from "citty";
import { consola } from "consola";

import {
	getStoredSessionMetadata,
	resumeSession,
	revokeSession,
	runInteractiveLogin,
	type StoredSessionMetadata,
} from "../oauth.js";
import { resolveAtprotoProfile } from "../profile.js";

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const PHASES = ["authorize", "resume", "revoke"] as const;
type Phase = (typeof PHASES)[number];

const SCOPE_DENIAL_BY_PROVIDER: Readonly<Record<string, PdsScopeDenialExpectation>> = {
	bluesky: { status: 403, error: "ScopeMissingError" },
	cirrus: { status: 403, error: "InsufficientScope" },
};

interface OAuthEvidence {
	requestedScope: string;
	before: StoredSessionMetadata | null;
	after: StoredSessionMetadata | null;
	scopeMatches: boolean;
	refreshDue: boolean;
	refreshForced: boolean;
	refreshObserved: boolean;
	serverRevoked?: boolean;
}

function parsePhase(value: string): Phase {
	if (value === "authorize" || value === "resume" || value === "revoke") return value;
	throw new Error(`--phase must be one of: ${PHASES.join(", ")}`);
}

function parseProvider(value: string): string {
	const provider = value.trim().toLowerCase();
	if (!PROVIDER_PATTERN.test(provider)) {
		throw new Error("--provider must contain 2-32 lowercase letters, digits, or hyphens");
	}
	scopeDenialExpectation(provider);
	return provider;
}

export function scopeDenialExpectation(provider: string): PdsScopeDenialExpectation {
	const expectation = SCOPE_DENIAL_BY_PROVIDER[provider];
	if (!expectation) throw new Error("--provider must be bluesky or cirrus");
	return expectation;
}

function createRunId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function defaultStateDir(provider: string): string {
	return join(homedir(), ".emdash", "pds-conformance", provider);
}

async function writeReport(output: string | undefined, value: unknown): Promise<void> {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	if (output) {
		const path = resolve(output);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await writeFile(path, body, { mode: 0o600 });
	}
	console.log(body.trimEnd());
}

async function resolveSession(input: {
	phase: Phase;
	identifier: string;
	stateDir: string;
	scope: string;
}): Promise<{ session: OAuthSession; did: `did:${string}:${string}` }> {
	if (input.phase === "authorize") {
		return runInteractiveLogin({
			identifier: input.identifier,
			stateDir: input.stateDir,
			scope: input.scope,
			allowLegacyScopeFallback: false,
			onUrl: (url) => {
				consola.info(`Authorize the exact delegated-release scope at:\n${url.toString()}`);
			},
		});
	}
	if (!isDid(input.identifier)) {
		throw new Error("Resume and revoke phases require the DID emitted by the authorize report");
	}
	return {
		did: input.identifier,
		session: await resumeSession(input.identifier, {
			stateDir: input.stateDir,
			scope: input.scope,
			refresh: input.phase === "resume",
		}),
	};
}

export const pdsConformanceCommand = defineCommand({
	meta: {
		name: "pds-conformance",
		description: "Run G0 create-only release-scope probes against a PDS",
		hidden: true,
	},
	args: {
		identifier: {
			type: "positional",
			description: "Account handle for authorize, or the report DID for resume/revoke",
			required: true,
		},
		provider: {
			type: "string",
			description: "Provider denial contract: bluesky or cirrus",
			required: true,
		},
		phase: {
			type: "string",
			description: "authorize, resume, or revoke",
			default: "authorize",
		},
		"state-dir": {
			type: "string",
			description: "Sensitive OAuth state directory",
		},
		output: {
			type: "string",
			description: "Optional path for the redacted JSON evidence report",
		},
	},
	async run({ args }) {
		const provider = parseProvider(args.provider);
		const phase = parsePhase(args.phase);
		const permission = getDelegatedReleasePermission();
		const stateDir = resolve(args["state-dir"] ?? defaultStateDir(provider));
		const identifier = args.identifier.trim();
		const metadataBefore = isDid(identifier)
			? await getStoredSessionMetadata(identifier, { stateDir })
			: null;
		const { session, did } = await resolveSession({
			phase,
			identifier,
			stateDir,
			scope: permission.scope,
		});
		const profile = await resolveAtprotoProfile(session);
		let serverRevoked: boolean | undefined;
		if (phase === "revoke") {
			serverRevoked = (
				await revokeSession(did, {
					stateDir,
					scope: permission.scope,
					strict: true,
				})
			).serverRevoked;
		}

		const probes = await runPdsScopeConformance({
			handler: session,
			did,
			pds: profile.pds,
			provider,
			runId: createRunId(),
			scopeDenial: scopeDenialExpectation(provider),
		});
		const metadataAfter = await getStoredSessionMetadata(did, { stateDir });
		const refreshDue =
			phase === "resume" &&
			typeof metadataBefore?.expiresAt === "number" &&
			metadataBefore.expiresAt <= Date.now();
		const refreshForced = phase === "resume";
		const refreshObserved =
			refreshForced &&
			typeof metadataAfter?.expiresAt === "number" &&
			metadataAfter.expiresAt > (metadataBefore?.expiresAt ?? 0);
		const oauth: OAuthEvidence = {
			requestedScope: permission.scope,
			before: metadataBefore,
			after: metadataAfter,
			scopeMatches: (metadataAfter ?? metadataBefore)?.scope === permission.scope,
			refreshDue,
			refreshForced,
			refreshObserved,
			...(serverRevoked !== undefined ? { serverRevoked } : {}),
		};
		const report = {
			version: 1,
			phase,
			provider,
			generatedAt: new Date().toISOString(),
			oauth,
			probes,
			notes:
				phase === "revoke"
					? "Post-revocation access-token behavior is observational until the token expires."
					: undefined,
		};
		await writeReport(args.output, report);

		if (phase !== "revoke" && (!probes.passed || !oauth.scopeMatches)) process.exit(1);
		if (phase === "resume" && !refreshObserved) process.exit(1);
	},
});
