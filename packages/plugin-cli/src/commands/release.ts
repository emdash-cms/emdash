import type { ReleaseIntentResource } from "@emdash-cms/registry-client/release-service";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import {
	cancelDelegatedReleaseIntent,
	getDelegatedReleaseIntent,
	submitDelegatedRelease,
} from "../release-service/operations.js";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const FAILURE_STATES = new Set([
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict",
]);

function requiredTarget(args: { "publisher-did"?: string; "service-url"?: string }) {
	const serviceUrl = args["service-url"] || process.env["EMDASH_RELEASE_SERVICE_URL"];
	const publisherDid = args["publisher-did"] || process.env["EMDASH_PUBLISHER_DID"];
	if (!serviceUrl) throw new Error("Release service URL is required");
	if (!publisherDid) throw new Error("Publisher DID is required");
	return { serviceUrl, publisherDid };
}

function positiveInteger(value: string, name: string, maximum: number): number {
	if (!POSITIVE_INTEGER_PATTERN.test(value)) throw new Error(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new Error(`${name} is outside the supported range`);
	}
	return parsed;
}

function printIntent(intent: ReleaseIntentResource, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(intent, null, 2));
		return;
	}
	console.log(`${pc.bold(intent.packageSlug)} ${pc.dim(intent.version)}`);
	console.log(`  Intent: ${intent.id}`);
	console.log(`  State:  ${intent.state}`);
	if (intent.approvalUrl) console.log(`  Approve: ${intent.approvalUrl}`);
	if (intent.result) {
		console.log(`  URI:    ${intent.result.uri}`);
		console.log(`  CID:    ${intent.result.cid}`);
	}
	if (intent.reasonCode) console.log(`  Reason: ${intent.reasonCode}`);
}

const commonArgs = {
	"service-url": {
		type: "string" as const,
		description: "Release service origin (or EMDASH_RELEASE_SERVICE_URL)",
	},
	"publisher-did": {
		type: "string" as const,
		description: "Publisher DID (or EMDASH_PUBLISHER_DID)",
	},
	json: {
		type: "boolean" as const,
		description: "Output the intent as JSON",
	},
};

export const releaseSubmitCommand = defineCommand({
	meta: {
		name: "submit",
		description: "Submit a delegated release from GitHub Actions OIDC",
	},
	args: {
		"release-file": {
			type: "positional",
			description: "Package release record JSON file",
			required: true,
		},
		...commonArgs,
		"idempotency-key": {
			type: "string",
			description: "Stable submission key (defaults to the GitHub run identity)",
		},
		"no-wait": {
			type: "boolean",
			description: "Return after the service accepts the intent",
		},
		"wait-for-approval": {
			type: "boolean",
			description: "Keep polling while the intent awaits approval",
			default: false,
		},
		"poll-interval-seconds": {
			type: "string",
			description: "Seconds between status requests",
			default: "5",
		},
		"timeout-minutes": {
			type: "string",
			description: "Maximum polling time",
			default: "30",
		},
	},
	async run({ args }) {
		const target = requiredTarget(args);
		let previousState: string | null = null;
		const intent = await submitDelegatedRelease({
			...target,
			releaseFile: args["release-file"],
			idempotencyKey: args["idempotency-key"],
			wait: !args["no-wait"],
			waitForApproval: args["wait-for-approval"],
			pollIntervalMs:
				positiveInteger(args["poll-interval-seconds"], "poll-interval-seconds", 300) * 1000,
			maxWaitMs: positiveInteger(args["timeout-minutes"], "timeout-minutes", 360) * 60_000,
			onUpdate: args.json
				? undefined
				: (current) => {
						if (current.state !== previousState) {
							previousState = current.state;
							consola.info(`Release intent ${current.id} entered ${current.state}`);
						}
					},
		});
		printIntent(intent, args.json ?? false);
		if (FAILURE_STATES.has(intent.state)) {
			throw new Error(
				`Release intent ended in ${intent.state}${intent.reasonCode ? ` (${intent.reasonCode})` : ""}`,
			);
		}
	},
});

export const releaseStatusCommand = defineCommand({
	meta: { name: "status", description: "Read a delegated release intent" },
	args: {
		"intent-id": {
			type: "positional",
			description: "Release intent ULID",
			required: true,
		},
		...commonArgs,
	},
	async run({ args }) {
		const intent = await getDelegatedReleaseIntent({
			...requiredTarget(args),
			intentId: args["intent-id"],
		});
		printIntent(intent, args.json ?? false);
	},
});

export const releaseCancelCommand = defineCommand({
	meta: { name: "cancel", description: "Cancel an unpublished delegated release intent" },
	args: {
		"intent-id": {
			type: "positional",
			description: "Release intent ULID",
			required: true,
		},
		...commonArgs,
		"idempotency-key": {
			type: "string",
			description: "Stable cancellation key (defaults to the GitHub run identity)",
		},
	},
	async run({ args }) {
		const intent = await cancelDelegatedReleaseIntent({
			...requiredTarget(args),
			intentId: args["intent-id"],
			idempotencyKey: args["idempotency-key"],
		});
		printIntent(intent, args.json ?? false);
	},
});

export const releaseCommand = defineCommand({
	meta: { name: "release", description: "Manage delegated release intents" },
	subCommands: {
		submit: releaseSubmitCommand,
		status: releaseStatusCommand,
		cancel: releaseCancelCommand,
	},
});
