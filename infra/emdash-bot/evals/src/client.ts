// HTTP client for the deployed worker's Flue agent surface.
//
// The eval runner dispatches the investigate agent directly over the token-
// gated `/agents/investigate/:id` routes (POST to dispatch, GET to read the
// conversation snapshot) and pulls the reported verdict out of the snapshot.
// `extractInvestigationResult` is pure and unit-tested; the network calls are
// operator-only.

import type { ReportedResult } from "./types.ts";

const TRAILING_SLASH = /\/$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AgentEndpoint {
	/** Base worker URL, e.g. https://emdash-bot-staging.example.workers.dev */
	readonly baseUrl: string;
	/** Bearer token gating `/agents/*` (the worker's GITHUB_WEBHOOK_SECRET). */
	readonly token: string;
}

export interface InvestigateInitialData {
	readonly runId: string;
	readonly issueNumber: number;
	readonly mode: "diagnose";
	readonly arg: string | null;
	readonly issueTitle: string;
	readonly issueBody: string;
	readonly previousBranchSha: string | null;
	readonly baseRef: string;
}

export interface DispatchReceipt {
	readonly submissionId?: string;
	readonly streamUrl?: string;
	readonly offset?: string;
}

function agentUrl(endpoint: AgentEndpoint, agentId: string): string {
	return `${endpoint.baseUrl.replace(TRAILING_SLASH, "")}/agents/investigate/${encodeURIComponent(agentId)}`;
}

function authHeaders(endpoint: AgentEndpoint): Record<string, string> {
	return { authorization: `Bearer ${endpoint.token}` };
}

/** Admit an investigation run. Returns as soon as the message is durably queued. */
export async function dispatchInvestigation(
	endpoint: AgentEndpoint,
	agentId: string,
	initialData: InvestigateInitialData,
): Promise<DispatchReceipt> {
	const response = await fetch(agentUrl(endpoint, agentId), {
		method: "POST",
		headers: { ...authHeaders(endpoint), "content-type": "application/json" },
		body: JSON.stringify({
			kind: "signal",
			type: "investigate.request",
			body: `Investigate issue #${initialData.issueNumber} in diagnose mode.`,
			initialData,
		}),
	});
	if (!response.ok) {
		throw new Error(`dispatch failed: ${response.status} ${await safeText(response)}`);
	}
	return response.json<DispatchReceipt>();
}

export interface Snapshot {
	readonly settlements?: readonly unknown[];
	readonly [key: string]: unknown;
}

export async function readSnapshot(endpoint: AgentEndpoint, agentId: string): Promise<Snapshot> {
	const response = await fetch(agentUrl(endpoint, agentId), { headers: authHeaders(endpoint) });
	if (!response.ok) {
		throw new Error(`snapshot read failed: ${response.status} ${await safeText(response)}`);
	}
	return response.json<Snapshot>();
}

async function safeText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 500);
	} catch {
		return "(no body)";
	}
}

export interface WaitOptions {
	readonly timeoutMs: number;
	readonly pollMs: number;
	/** Injectable clock/poller for tests; defaults to real time + `readSnapshot`. */
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly fetchSnapshot?: (agentId: string) => Promise<Snapshot>;
}

/**
 * Poll the conversation until the investigation reports a result or the agent
 * settles without one. Returns the reported result, or null if the run settled
 * with no parseable verdict (which the caller scores as a harness error).
 */
export async function waitForResult(
	endpoint: AgentEndpoint,
	agentId: string,
	options: WaitOptions,
): Promise<ReportedResult | null> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const fetchSnapshot = options.fetchSnapshot ?? ((id: string) => readSnapshot(endpoint, id));
	const deadline = now() + options.timeoutMs;

	for (;;) {
		const snapshot = await fetchSnapshot(agentId);
		const result = extractInvestigationResult(snapshot);
		if (result) return result;
		if (Array.isArray(snapshot.settlements) && snapshot.settlements.length > 0) {
			// Settled without a reported verdict -- no result to extract.
			return null;
		}
		if (now() >= deadline) {
			throw new Error(`timed out after ${options.timeoutMs}ms waiting for a verdict`);
		}
		await sleep(options.pollMs);
	}
}

function looksLikeReported(value: unknown): value is ReportedResult {
	if (!isRecord(value)) return false;
	if (typeof value.ok !== "boolean" || typeof value.pushed !== "boolean") return false;
	if (typeof value.runId !== "string" || !Array.isArray(value.verification)) return false;
	if (value.publication !== null && !isRecord(value.publication)) return false;
	return isRecord(value.result) && typeof value.result.summary === "string";
}

/**
 * Find the reported investigation result anywhere in a conversation snapshot.
 * The agent emits the reported result via both a data writer and the
 * `report_result` tool output; rather than couple to Flue's exact snapshot
 * envelope, this scans for that payload shape and returns the last one emitted
 * (the final report). Stringified JSON payloads are parsed and searched too.
 */
export function extractInvestigationResult(snapshot: unknown): ReportedResult | null {
	const matches: ReportedResult[] = [];
	const seen = new Set<unknown>();

	const walk = (value: unknown): void => {
		if (looksLikeReported(value)) matches.push(value);
		if (typeof value === "string") {
			if (value.includes('"ok"') && value.includes('"pushed"')) {
				try {
					const parsed: unknown = JSON.parse(value);
					walk(parsed);
				} catch {
					// not JSON; ignore
				}
			}
			return;
		}
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (isRecord(value)) {
			for (const item of Object.values(value)) walk(item);
		}
	};

	walk(snapshot);
	return matches.at(-1) ?? null;
}
