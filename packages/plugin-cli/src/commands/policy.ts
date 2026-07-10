import { FileCredentialStore, PublishingClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";

import { redirectConsolaToStderr } from "../cli-output.js";
import { loadManifest, MANIFEST_FILENAME, ManifestError } from "../manifest/load.js";
import { checkPublisher, PublisherCheckError } from "../manifest/publisher.js";
import { resumeSession } from "../oauth.js";
import { ProfilePolicyError, setProfilePolicy } from "../policy/api.js";

export const policySetArgs = {
	manifest: {
		type: "string",
		description: `Manifest path or directory. Defaults to ./${MANIFEST_FILENAME}.`,
	},
	repository: {
		type: "string",
		description: "HTTPS repository anchor, required only when creating the profile extension.",
	},
	"require-provenance": {
		type: "boolean",
		description: "Require verifiable release provenance.",
	},
	confirmation: {
		type: "string",
		description: "Release confirmation: escalation-only or always.",
	},
	approver: {
		type: "string",
		description: "Approver DID. Repeat to replace the complete approver list.",
	},
	"clear-approvers": {
		type: "boolean",
		description: "Replace the complete approver list with an empty list.",
	},
	yes: {
		type: "boolean",
		default: false,
		description: "Apply the policy change. The default is a dry-run.",
	},
	json: { type: "boolean", description: "Emit stable single-line JSON to stdout." },
} as const;

export const policySetCommand = defineCommand({
	meta: { name: "set", description: "Edit the release policy on an existing package profile" },
	args: policySetArgs,
	async run({ args, rawArgs }) {
		const json = args.json === true;
		const restoreReporters = json ? redirectConsolaToStderr() : null;
		let exitCode = 0;
		try {
			const commandInput = resolvePolicyCommandInput(args, rawArgs);
			const { manifest, path } = await loadPolicyManifest(commandInput.manifestPath);
			const credentials = new FileCredentialStore();
			const session = await credentials.current();
			if (!session)
				throw new CliError(
					"Not logged in. Run: emdash-plugin login <handle-or-did>",
					"NOT_LOGGED_IN",
				);
			try {
				const publisherCheck = await checkPublisher({
					manifestPublisher: manifest.publisher,
					sessionDid: session.did,
				});
				if (publisherCheck.kind === "mismatch") {
					throw new CliError(
						`Manifest publisher ${publisherCheck.pinnedDid} does not match the active session ${session.did}.`,
						"MANIFEST_PUBLISHER_MISMATCH",
					);
				}
			} catch (error) {
				if (error instanceof PublisherCheckError) {
					throw new CliError(error.message, error.code);
				}
				throw error;
			}
			consola.info(`Loaded manifest: ${path}`);
			const oauthSession = await resumeSession(session.did);
			const publisher = PublishingClient.fromHandler({
				handler: oauthSession,
				did: session.did,
				pds: session.pds,
			});
			const result = await setProfilePolicy({
				publisher,
				slug: manifest.slug,
				apply: commandInput.apply,
				input: commandInput.input,
			});
			if (json) {
				process.stdout.write(
					`${JSON.stringify(formatPolicyJsonResult(result, commandInput.apply))}\n`,
				);
				return;
			}
			if (result.diffs.length === 0)
				consola.success("Package release policy is already up to date.");
			else if (result.written) consola.success(`Updated release policy: ${result.profileUri}`);
			else consola.info("Dry-run complete. Re-run with --yes to write this policy change.");
		} catch (error) {
			const code =
				error instanceof ProfilePolicyError || error instanceof CliError
					? error.code
					: "INTERNAL_ERROR";
			const message = error instanceof Error ? error.message : String(error);
			consola.error(message);
			if (json) process.stdout.write(`${JSON.stringify(formatPolicyJsonError(code, message))}\n`);
			exitCode = 1;
		} finally {
			restoreReporters?.();
		}
		if (exitCode !== 0) process.exit(exitCode);
	},
});

export const policyCommand = defineCommand({
	meta: { name: "policy", description: "Manage a package profile's release policy" },
	subCommands: { set: policySetCommand },
});

export function resolvePolicyCommandInput(args: Record<string, unknown>, rawArgs: string[]) {
	const provenanceFlags = rawArgs.filter(
		(arg) => arg === "--require-provenance" || arg === "--no-require-provenance",
	);
	if (provenanceFlags.length > 1 || Array.isArray(args["require-provenance"])) {
		throw new CliError(
			"Specify --require-provenance or --no-require-provenance at most once.",
			"INVALID_POLICY_FLAGS",
		);
	}
	const clearApproverFlags = rawArgs.filter((arg) => arg === "--clear-approvers");
	if (clearApproverFlags.length > 1 || Array.isArray(args["clear-approvers"])) {
		throw new CliError("Specify --clear-approvers at most once.", "INVALID_POLICY_FLAGS");
	}
	const approvers = toStringArray(args.approver);
	if (args["clear-approvers"] === true && approvers !== undefined) {
		throw new CliError(
			"--clear-approvers cannot be combined with --approver.",
			"INVALID_POLICY_FLAGS",
		);
	}
	const provenance = args["require-provenance"];
	if (provenance !== undefined && typeof provenance !== "boolean") {
		throw new CliError("Invalid --require-provenance value.", "INVALID_POLICY_FLAGS");
	}
	return {
		manifestPath: typeof args.manifest === "string" ? args.manifest : `./${MANIFEST_FILENAME}`,
		apply: args.yes === true,
		input: {
			repository: typeof args.repository === "string" ? args.repository : undefined,
			requireProvenance: provenance,
			confirmation: typeof args.confirmation === "string" ? args.confirmation : undefined,
			approvers: args["clear-approvers"] === true ? [] : approvers,
		},
	};
}

export function formatPolicyJsonResult(
	result: Awaited<ReturnType<typeof setProfilePolicy>>,
	applied: boolean,
) {
	return {
		profile: result.profileUri,
		written: result.written,
		applied,
		diffs: result.diffs,
		...(result.cid ? { cid: result.cid } : {}),
	};
}

export function formatPolicyJsonError(code: string, message: string) {
	return { error: { code, message } };
}

async function loadPolicyManifest(path: string) {
	try {
		return await loadManifest(path);
	} catch (error) {
		if (error instanceof ManifestError) throw new CliError(error.message, error.code);
		throw error;
	}
}

function toStringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return typeof value === "string" ? [value] : undefined;
}

class CliError extends Error {
	override readonly name = "CliError";
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}
