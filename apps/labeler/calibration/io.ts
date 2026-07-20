/**
 * Filesystem shell for the calibration harness (plan W8.6). Node-only: the
 * runner reads fixtures and writes run artifacts through here, keeping the
 * conversion, adapter, and report logic pure and unit-testable. Run artifacts
 * live under `runs/` (gitignored) — review outputs, not source.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
	parseExpectation,
	type Expectation,
	type FixtureManifest,
	type RawFixtureFile,
} from "./fixture-loader.js";
import type { CallRecord, LoadedRun, RunManifest } from "./types.js";

export const CALIBRATION_DIR = import.meta.dirname;
export const FIXTURES_DIR = join(CALIBRATION_DIR, "fixtures");
export const RUNS_DIR = join(CALIBRATION_DIR, "runs");

export interface LoadedFixture {
	readonly name: string;
	readonly manifest: FixtureManifest;
	readonly manifestRaw: string;
	readonly files: readonly RawFixtureFile[];
	readonly imageBytes: Uint8Array | null;
	readonly expected: Expectation;
}

function parseManifest(raw: string, name: string): FixtureManifest {
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value)) throw new TypeError(`fixture ${name}: manifest.json is not an object`);
	const record = value;
	if (typeof record.id !== "string" || typeof record.version !== "string")
		throw new TypeError(`fixture ${name}: manifest.json needs string id and version`);
	const capabilities = Array.isArray(record.capabilities)
		? record.capabilities.filter((entry): entry is string => typeof entry === "string")
		: [];
	return { id: record.id, version: record.version, capabilities };
}

export function loadFixtures(): LoadedFixture[] {
	const entries = readdirSync(FIXTURES_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.toSorted();

	return entries.map((name) => {
		const dir = join(FIXTURES_DIR, name);
		const manifestRaw = readFileSync(join(dir, "manifest.json"), "utf8");
		const backend = readFileSync(join(dir, "backend.js"), "utf8");
		const expected = parseExpectation(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")));
		const iconPath = join(dir, "icon.png");
		const imageBytes = existsSync(iconPath) ? new Uint8Array(readFileSync(iconPath)) : null;
		return {
			name,
			manifest: parseManifest(manifestRaw, name),
			manifestRaw,
			files: [{ path: "backend.js", content: backend }],
			imageBytes,
			expected,
		};
	});
}

function sanitize(modelId: string): string {
	return modelId.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

const MAX_LABEL_LENGTH = 64;
// The label is operator-supplied (CALIBRATE_LABEL) and joined into the run
// path, so it must not carry `/`, `..`, or a leading dot that could escape
// runs/. Alphanumeric start, then alphanumerics plus `.`, `-`, `_`.
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function createRunDir(timestamp: string, label: string): string {
	if (label.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label))
		throw new Error(
			`calibration: invalid run label ${JSON.stringify(label)} — must match ${LABEL_PATTERN} and be at most ${MAX_LABEL_LENGTH} characters`,
		);
	const runDir = join(RUNS_DIR, `${timestamp.replaceAll(":", "-")}-${label}`);
	// Defense in depth: never create a directory outside runs/, whatever the
	// label pattern lets through.
	const resolved = resolve(runDir);
	if (resolved !== RUNS_DIR && !resolved.startsWith(RUNS_DIR + sep))
		throw new Error(`calibration: run dir ${resolved} escapes ${RUNS_DIR}`);
	mkdirSync(runDir, { recursive: true });
	return runDir;
}

/** Written per record as the sweep runs, so a long or interrupted sweep still
 * leaves partial results on disk. Refuses to overwrite: two records sharing a
 * fixture×lane×sanitized-model filename would silently clobber one another
 * (e.g. two model ids that sanitize to the same string), so a collision is a
 * bug, not a resumable state. */
export function writeRecord(runDir: string, record: CallRecord): void {
	const file = `${record.fixture}__${record.lane}__${sanitize(record.modelId)}.json`;
	const path = join(runDir, file);
	if (existsSync(path))
		throw new Error(`calibration: duplicate record file ${file} — fixture×lane×model collision`);
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function writeManifest(runDir: string, manifest: RunManifest): void {
	writeFileSync(join(runDir, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function loadRun(runDir: string): LoadedRun {
	const manifestPath = join(runDir, "run-manifest.json");
	if (!existsSync(manifestPath))
		throw new Error(
			`calibration: incomplete run at ${runDir} (no run-manifest.json — sweep interrupted?)`,
		);
	const manifest: RunManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const records = readdirSync(runDir)
		.filter((file) => file.endsWith(".json") && file !== "run-manifest.json")
		.toSorted()
		.map((file): CallRecord => JSON.parse(readFileSync(join(runDir, file), "utf8")));
	if (records.length !== manifest.recordCount)
		throw new Error(
			`calibration: run at ${runDir} has ${records.length} record files but manifest.recordCount is ${manifest.recordCount}`,
		);
	return { manifest, records };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
