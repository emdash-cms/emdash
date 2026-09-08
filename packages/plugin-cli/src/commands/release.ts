import type {
	DryRunReleaseIntentResult,
	ReleaseIntentResource,
} from "@emdash-cms/registry-client/release-service";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import {
	cancelDelegatedReleaseIntent,
	dryRunDelegatedRelease,
	getDelegatedReleaseIntent,
	interactiveReleaseUrl,
	submitDelegatedRelease,
	type InteractiveReleaseAction,
} from "../release-service/operations.js";
import { releaseSetupCommand } from "../release-setup.js";

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

function requiredService(args: { "service-url"?: string }): string {
	const serviceUrl = args["service-url"] || process.env["EMDASH_RELEASE_SERVICE_URL"];
	if (!serviceUrl) throw new Error("Release service URL is required");
	return serviceUrl;
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

function printDryRun(result: DryRunReleaseIntentResult, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`${pc.bold(result.packageSlug)} ${pc.dim(result.version)}`);
	console.log("  Admission: allowed");
	console.log(`  Policy:    ${result.workloadPolicyVersion}`);
}

function printBrowserHandoff(action: InteractiveReleaseAction, url: URL, json?: boolean): void {
	if (json) {
		console.log(JSON.stringify({ action, url: url.toString() }));
		return;
	}
	consola.info("Open your browser to:");
	console.log(`  ${pc.cyan(pc.bold(url.toString()))}`);
	consola.info("OAuth sessions and passkey assertions remain in the browser.");
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

const browserArgs = {
	"service-url": commonArgs["service-url"],
	json: {
		type: "boolean" as const,
		description: "Output the browser handoff as JSON",
	},
};

export const releaseDelegateCommand = defineCommand({
	meta: { name: "delegate", description: "Print a browser handoff for publisher delegation" },
	args: browserArgs,
	async run({ args }) {
		const url = interactiveReleaseUrl("delegate", { serviceUrl: requiredService(args) });
		printBrowserHandoff("delegate", url, args.json);
	},
});

export const releaseRevokeCommand = defineCommand({
	meta: { name: "revoke", description: "Print a browser handoff for authority revocation" },
	args: browserArgs,
	async run({ args }) {
		const url = interactiveReleaseUrl("revoke", { serviceUrl: requiredService(args) });
		printBrowserHandoff("revoke", url, args.json);
	},
});

export const releaseWorkloadCommand = defineCommand({
	meta: { name: "workload", description: "Print a browser handoff for workload policies" },
	args: browserArgs,
	async run({ args }) {
		const url = interactiveReleaseUrl("workload", { serviceUrl: requiredService(args) });
		printBrowserHandoff("workload", url, args.json);
	},
});

export const releaseEnrolCommand = defineCommand({
	meta: { name: "enrol", description: "Print a browser handoff for passkey enrolment" },
	args: browserArgs,
	async run({ args }) {
		const url = interactiveReleaseUrl("enrol", { serviceUrl: requiredService(args) });
		printBrowserHandoff("enrol", url, args.json);
	},
});

const approvalBrowserArgs = {
	"intent-id": {
		type: "positional" as const,
		description: "Release intent ULID",
		required: true,
	},
	...browserArgs,
	"publisher-did": commonArgs["publisher-did"],
};

export const releaseApproveCommand = defineCommand({
	meta: { name: "approve", description: "Print a browser handoff for passkey approval" },
	args: approvalBrowserArgs,
	async run({ args }) {
		const target = requiredTarget(args);
		const url = interactiveReleaseUrl("approve", {
			...target,
			intentId: args["intent-id"],
		});
		printBrowserHandoff("approve", url, args.json);
	},
});

export const releaseRejectCommand = defineCommand({
	meta: { name: "reject", description: "Print a browser handoff for passkey rejection" },
	args: approvalBrowserArgs,
	async run({ args }) {
		const target = requiredTarget(args);
		const url = interactiveReleaseUrl("reject", {
			...target,
			intentId: args["intent-id"],
		});
		printBrowserHandoff("reject", url, args.json);
	},
});

export const releaseSubmitCommand = defineCommand({
	meta: {
		name: "submit",
		description: "Submit a delegated release from GitHub Actions OIDC",
	},
	args: {
		"release-file": {
			type: "positional",
			description: "URL-source package release JSON file",
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
		let connectionRequestId: string | null = null;
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
			onConnectionUpdate: args.json
				? undefined
				: (current) => {
						if (current.status === "pending" && current.request.id !== connectionRequestId) {
							connectionRequestId = current.request.id;
							consola.info("Approve this GitHub workflow to continue:");
							console.log(`  ${pc.cyan(pc.bold(current.approvalUrl))}`);
						}
					},
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

export const releaseDryRunCommand = defineCommand({
	meta: {
		name: "dry-run",
		description: "Validate delegated release admission without creating an intent",
	},
	args: {
		"release-file": {
			type: "positional",
			description: "URL-source package release JSON file",
			required: true,
		},
		...commonArgs,
	},
	async run({ args }) {
		const result = await dryRunDelegatedRelease({
			...requiredTarget(args),
			releaseFile: args["release-file"],
		});
		printDryRun(result, args.json ?? false);
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
		approve: releaseApproveCommand,
		delegate: releaseDelegateCommand,
		"dry-run": releaseDryRunCommand,
		enrol: releaseEnrolCommand,
		reject: releaseRejectCommand,
		revoke: releaseRevokeCommand,
		setup: releaseSetupCommand,
		submit: releaseSubmitCommand,
		status: releaseStatusCommand,
		cancel: releaseCancelCommand,
		workload: releaseWorkloadCommand,
	},
});
