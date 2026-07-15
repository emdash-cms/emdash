/**
 * Recorded-artifact shapes (plan W8.6). The runner writes one `CallRecord`
 * per fixture x lane x model plus a `RunManifest`; the report reads them back.
 * Errors are recorded as data (`ok: false`, `error` populated), never thrown.
 */

import type { LaneExpectation } from "./fixture-loader.js";
import type { CallDiagnostics } from "./rest-ai-binding.js";

export type Lane = "code" | "image";
export type OutcomeState = "passed" | "warned" | "blocked";

export interface RecordedLabel {
	readonly val: string;
	readonly findingCategory?: string;
	readonly severity?: string;
}

export interface RecordedFinding {
	readonly source: string;
	readonly category: string;
	readonly severity: string;
	readonly confidence?: number;
	readonly title: string;
	readonly publicSummary: string;
	readonly privateDetail: string;
}

export interface CallRecord {
	readonly fixture: string;
	readonly lane: Lane;
	readonly modelId: string;
	readonly promptVersion: string;
	readonly ok: boolean;
	readonly outcome: {
		readonly toState: OutcomeState;
		readonly labels: readonly RecordedLabel[];
	} | null;
	readonly findings: readonly RecordedFinding[];
	readonly coverage: "complete" | "partial" | null;
	readonly dropped: readonly string[];
	readonly call: {
		readonly modelId: string;
		readonly promptVersion: string;
		readonly promptHash: string;
	} | null;
	readonly diagnostics: CallDiagnostics | null;
	readonly error: { readonly name: string; readonly message: string } | null;
	readonly latencyMs: number;
	readonly expected: LaneExpectation | null;
}

export interface RunManifest {
	readonly label: string;
	readonly timestamp: string;
	readonly promptVersion: string;
	readonly policyVersion: string;
	readonly models: readonly { readonly modelId: string; readonly lanes: readonly Lane[] }[];
	readonly fixtures: readonly string[];
	readonly codeModels: readonly string[];
	readonly imageModels: readonly string[];
	readonly recordCount: number;
}

export interface LoadedRun {
	readonly manifest: RunManifest;
	readonly records: readonly CallRecord[];
}
