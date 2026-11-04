import { base64url } from "jose";

import type { PublisherDurableObject } from "../publisher-do/publisher-do.js";
import type { ReleaseIntentWorkflowParams } from "./release-intent.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type StartReleaseWorkflowResult =
	| { ok: true; workflowId: string; created: boolean }
	| {
			ok: false;
			code: "INTENT_NOT_FOUND" | "INTENT_STATE_INVALID" | "WORKFLOW_UNAVAILABLE";
	  };

export type RestartReleaseWorkflowResult =
	| { ok: true; workflowId: string; restarted: boolean }
	| {
			ok: false;
			code: "INTENT_NOT_FOUND" | "INTENT_STATE_INVALID" | "WORKFLOW_UNAVAILABLE";
	  };

async function digest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function startReleaseIntentWorkflow(
	workflow: Workflow<ReleaseIntentWorkflowParams>,
	publishers: DurableObjectNamespace<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
): Promise<StartReleaseWorkflowResult> {
	if (!DID_PATTERN.test(publisherDid) || !ULID_PATTERN.test(intentId)) {
		return { ok: false, code: "INTENT_STATE_INVALID" };
	}
	const publisher = publishers.getByName(publisherDid);
	const intent = await publisher.getIntent(publisherDid, intentId);
	if (!intent) return { ok: false, code: "INTENT_NOT_FOUND" };
	if (intent.workflowId !== null && intent.workflowId !== intentId) {
		return { ok: false, code: "INTENT_STATE_INVALID" };
	}
	const needsCreation = intent.state === "received";
	if (needsCreation) {
		const transition = await publisher.transitionIntent({
			publisherDid,
			intentId,
			expectedState: "received",
			expectedGeneration: intent.stateGeneration,
			toState: "verifying",
			transitionDigest: await digest(["workflow-start", publisherDid, intentId]),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: JSON.stringify({ workflowId: intentId }),
			workflowId: intentId,
		});
		if (!transition.ok) return { ok: false, code: "INTENT_STATE_INVALID" };
	} else if (intent.workflowId !== intentId) {
		return { ok: false, code: "INTENT_STATE_INVALID" };
	}
	if (!needsCreation) {
		try {
			const existing = await workflow.get(intentId);
			const status = await existing.status();
			if (status.status !== "unknown") {
				return { ok: true, workflowId: intentId, created: false };
			}
			if (intent.state !== "verifying") {
				return { ok: false, code: "WORKFLOW_UNAVAILABLE" };
			}
		} catch {
			if (intent.state !== "verifying") {
				return { ok: false, code: "WORKFLOW_UNAVAILABLE" };
			}
		}
	}
	try {
		await workflow.create({ id: intentId, params: { publisherDid, intentId } });
		return { ok: true, workflowId: intentId, created: true };
	} catch {
		try {
			const existing = await workflow.get(intentId);
			const status = await existing.status();
			return status.status === "unknown"
				? { ok: false, code: "WORKFLOW_UNAVAILABLE" }
				: { ok: true, workflowId: intentId, created: false };
		} catch {
			return { ok: false, code: "WORKFLOW_UNAVAILABLE" };
		}
	}
}

export async function restartReleaseIntentWorkflow(
	workflow: Workflow<ReleaseIntentWorkflowParams>,
	publishers: DurableObjectNamespace<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
): Promise<RestartReleaseWorkflowResult> {
	if (!DID_PATTERN.test(publisherDid) || !ULID_PATTERN.test(intentId)) {
		return { ok: false, code: "INTENT_STATE_INVALID" };
	}
	const intent = await publishers.getByName(publisherDid).getIntent(publisherDid, intentId);
	if (!intent) return { ok: false, code: "INTENT_NOT_FOUND" };
	if (
		intent.workflowId !== intentId ||
		(intent.state !== "ready" && intent.state !== "reconciling")
	) {
		return { ok: false, code: "INTENT_STATE_INVALID" };
	}
	try {
		const instance = await workflow.get(intentId);
		const status = await instance.status();
		if (
			status.status === "queued" ||
			status.status === "running" ||
			status.status === "waiting" ||
			status.status === "paused" ||
			status.status === "waitingForPause"
		) {
			return { ok: true, workflowId: intentId, restarted: false };
		}
		if (status.status === "unknown") return { ok: false, code: "WORKFLOW_UNAVAILABLE" };
		await instance.restart();
		return { ok: true, workflowId: intentId, restarted: true };
	} catch {
		return { ok: false, code: "WORKFLOW_UNAVAILABLE" };
	}
}
