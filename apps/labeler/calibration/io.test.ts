import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRunDir, loadRun, RUNS_DIR, writeManifest, writeRecord } from "./io.js";
import type { CallRecord, RunManifest } from "./types.js";

const TS = "2026-07-15T00-00-00Z";

function record(
	overrides: Partial<CallRecord> & Pick<CallRecord, "fixture" | "modelId">,
): CallRecord {
	return {
		lane: "code",
		promptVersion: "test",
		ok: true,
		outcome: { toState: "passed", labels: [] },
		findings: [],
		coverage: "complete",
		dropped: [],
		call: null,
		diagnostics: null,
		error: null,
		latencyMs: 1,
		expected: null,
		...overrides,
	};
}

function manifest(recordCount: number): RunManifest {
	return {
		label: "t",
		timestamp: "2026-07-15T00:00:00Z",
		promptVersion: "test",
		policyVersion: "test.1",
		models: [],
		fixtures: ["a"],
		codeModels: ["@cf/x/a"],
		imageModels: [],
		recordCount,
	};
}

describe("io round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "calib-io-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes and reloads records with a matching manifest recordCount", () => {
		writeRecord(dir, record({ fixture: "a", modelId: "@cf/x/a" }));
		writeRecord(dir, record({ fixture: "a", modelId: "@cf/x/b" }));
		writeManifest(dir, manifest(2));
		const run = loadRun(dir);
		expect(run.records).toHaveLength(2);
		expect(run.manifest.recordCount).toBe(2);
	});

	it("refuses to overwrite a colliding fixture×lane×model filename", () => {
		writeRecord(dir, record({ fixture: "a", modelId: "@cf/x/a" }));
		// "@cf/x/a" and "@cf.x.a" sanitize to the same filename.
		expect(() => writeRecord(dir, record({ fixture: "a", modelId: "@cf.x.a" }))).toThrow(
			/duplicate record file/,
		);
	});

	it("throws a clear error on a manifest-less (interrupted) run dir", () => {
		writeRecord(dir, record({ fixture: "a", modelId: "@cf/x/a" }));
		expect(() => loadRun(dir)).toThrow(/no run-manifest\.json — sweep interrupted/);
	});

	it("throws when record file count disagrees with manifest.recordCount", () => {
		writeRecord(dir, record({ fixture: "a", modelId: "@cf/x/a" }));
		writeManifest(dir, manifest(5));
		expect(() => loadRun(dir)).toThrow(/record files but manifest\.recordCount is 5/);
	});
});

describe("createRunDir label validation", () => {
	it("rejects a path-traversal label", () => {
		expect(() => createRunDir(TS, "../../../tmp/pwned")).toThrow(/invalid run label/);
	});

	it("rejects an absolute-path label", () => {
		expect(() => createRunDir(TS, "/etc/passwd")).toThrow(/invalid run label/);
	});

	it("rejects a label with a path separator or leading dot", () => {
		expect(() => createRunDir(TS, "a/b")).toThrow(/invalid run label/);
		expect(() => createRunDir(TS, ".hidden")).toThrow(/invalid run label/);
	});

	it("creates a dir under runs/ for a valid label", () => {
		const label = `iotest-${Date.now()}`;
		const runDir = createRunDir(TS, label);
		try {
			expect(runDir.startsWith(RUNS_DIR + sep)).toBe(true);
			expect(runDir.endsWith(`${TS}-${label}`)).toBe(true);
			expect(existsSync(runDir)).toBe(true);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
