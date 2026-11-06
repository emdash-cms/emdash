import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { handleArchivePublisher } from "../backup/routes.js";
import { loadConfiguration } from "../config.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_ARCHIVE_PAGES = 10_000;
const STEP_CONFIG = {
	retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
	timeout: "5 minutes",
} as const;

export interface PublisherArchiveWorkflowParams {
	publisherDid: string;
	archiveId: string;
	actorIdentity: string;
}

export interface PublisherArchiveWorkflowOutput {
	publisherDid: string;
	archiveId: string;
	ownerHash: string;
	pages: number;
}

export type StartPublisherArchiveWorkflowResult =
	| { ok: true; workflowId: string; created: boolean }
	| { ok: false; code: "ARCHIVE_WORKFLOW_UNAVAILABLE" };

interface ArchivePageOutput {
	ownerHash: string;
	nextCursor: string | null;
	nextPage: number;
	complete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validParams(value: unknown): value is PublisherArchiveWorkflowParams {
	return (
		isRecord(value) &&
		typeof value["publisherDid"] === "string" &&
		DID_PATTERN.test(value["publisherDid"]) &&
		typeof value["archiveId"] === "string" &&
		ARCHIVE_ID_PATTERN.test(value["archiveId"]) &&
		typeof value["actorIdentity"] === "string" &&
		ACTOR_IDENTITY_PATTERN.test(value["actorIdentity"])
	);
}

async function workflowId(publisherDid: string, archiveId: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify(["publisher-archive-workflow", 1, publisherDid, archiveId]),
				),
			),
		),
	);
}

export async function startPublisherArchiveWorkflow(
	workflow: Workflow<PublisherArchiveWorkflowParams>,
	params: PublisherArchiveWorkflowParams,
): Promise<StartPublisherArchiveWorkflowResult> {
	if (!validParams(params)) return { ok: false, code: "ARCHIVE_WORKFLOW_UNAVAILABLE" };
	const id = await workflowId(params.publisherDid, params.archiveId);
	try {
		await workflow.create({ id, params });
		return { ok: true, workflowId: id, created: true };
	} catch {
		try {
			const existing = await workflow.get(id);
			const status = await existing.status();
			if (status.status === "unknown") {
				return { ok: false, code: "ARCHIVE_WORKFLOW_UNAVAILABLE" };
			}
			if (status.status === "errored" || status.status === "terminated") {
				await existing.restart();
			}
			return { ok: true, workflowId: id, created: false };
		} catch {
			return { ok: false, code: "ARCHIVE_WORKFLOW_UNAVAILABLE" };
		}
	}
}

function parseArchivePage(value: unknown, expectedPage: number): ArchivePageOutput {
	if (!isRecord(value) || !isRecord(value["data"])) {
		throw new Error("Publisher archive page response is invalid");
	}
	const data = value["data"];
	if (
		typeof data["ownerHash"] !== "string" ||
		data["ownerHash"].length !== 43 ||
		(data["nextCursor"] !== null && typeof data["nextCursor"] !== "string") ||
		data["nextPage"] !== expectedPage + 1 ||
		typeof data["complete"] !== "boolean" ||
		data["complete"] !== (data["nextCursor"] === null)
	) {
		throw new Error("Publisher archive page response is invalid");
	}
	return {
		ownerHash: data["ownerHash"],
		nextCursor: data["nextCursor"],
		nextPage: data["nextPage"],
		complete: data["complete"],
	};
}

export class PublisherArchiveWorkflow extends WorkflowEntrypoint<
	Env,
	PublisherArchiveWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<PublisherArchiveWorkflowParams>>,
		step: WorkflowStep,
	): Promise<PublisherArchiveWorkflowOutput> {
		if (!validParams(event.payload)) {
			throw new NonRetryableError("Invalid publisher-archive Workflow parameters");
		}
		const params = event.payload;
		const actor: AccessActor = {
			realm: "access",
			identity: params.actorIdentity,
			email: "archive-workflow@emdash.invalid",
			role: "admin",
		};
		let cursor: string | null = null;
		let page = 0;
		let ownerHash: string | null = null;
		while (page < MAX_ARCHIVE_PAGES) {
			const pageCursor = cursor;
			const pageNumber = page;
			const result = await step.do<ArchivePageOutput>(
				`publisher-archive-${pageNumber}`,
				STEP_CONFIG,
				async () => {
					const configuration = await loadConfiguration(this.env);
					const response = await handleArchivePublisher(
						new Request(`${configuration.publicOrigin}/admin/api/publishers/archive`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"idempotency-key": `archive-${params.archiveId}-${pageNumber}`,
							},
							body: JSON.stringify({
								archiveId: params.archiveId,
								cursor: pageCursor,
								page: pageNumber,
							}),
						}),
						`archive-${pageNumber}`,
						configuration,
						{ publisherDid: params.publisherDid },
						actor,
					);
					if (!response.ok) throw new Error("Publisher archive page failed");
					return parseArchivePage(await response.json(), pageNumber);
				},
			);
			ownerHash ??= result.ownerHash;
			if (ownerHash !== result.ownerHash) {
				throw new NonRetryableError("Publisher archive owner changed");
			}
			page = result.nextPage;
			cursor = result.nextCursor;
			if (result.complete) {
				return {
					publisherDid: params.publisherDid,
					archiveId: params.archiveId,
					ownerHash,
					pages: page,
				};
			}
		}
		throw new NonRetryableError("Publisher archive exceeded the page limit");
	}
}
