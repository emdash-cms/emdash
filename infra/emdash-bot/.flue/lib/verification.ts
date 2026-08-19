export interface VerificationRecord {
	readonly name: string;
	readonly command: string;
	readonly cwd?: string;
	readonly exitCode: number;
	readonly candidateTreeSha: string;
}

export interface VerificationIdentity {
	readonly name: string;
	readonly command: string;
	readonly cwd?: string;
}

export class StaleVerificationError extends Error {
	readonly checks: readonly string[];

	constructor(checks: readonly string[]) {
		super(
			`Cannot report a terminal result because the candidate changed after verification. Rerun every listed check with its existing name and command on the current candidate, then call publish_candidate again. Stale checks: ${checks.join(", ")}.`,
		);
		this.name = "StaleVerificationError";
		this.checks = [...checks];
	}
}

export function requireTerminalReportAllowed(
	failure: { readonly message: string; readonly recoverable?: boolean } | null,
	records: readonly VerificationRecord[] = [],
	candidateTreeSha?: string,
): void {
	if (failure?.recoverable === true) {
		throw new Error(
			`Cannot report a terminal result while verification is recoverable. ${failure.message}`,
		);
	}
	if (candidateTreeSha === undefined || records.length === 0) return;
	try {
		passingVerificationRecords(records, candidateTreeSha);
	} catch (error) {
		if (error instanceof StaleVerificationError) throw error;
	}
}

const PIPE_OPERATOR = /\|/;
const STATUS_MASKING_SHELL_CONTROL = /[;&\r\n]/;
const LEADING_SHELL_NEGATION = /^\s*!/;

export function assertVerificationCommand(command: string): void {
	if (PIPE_OPERATOR.test(command)) {
		throw new Error(
			"verification commands cannot contain a pipeline or || fallback; run the check directly so its exit code is authoritative",
		);
	}
	if (STATUS_MASKING_SHELL_CONTROL.test(command)) {
		throw new Error(
			"verification commands cannot contain shell control operators that can replace the check's exit code",
		);
	}
	if (LEADING_SHELL_NEGATION.test(command)) {
		throw new Error("verification commands cannot negate a check to replace its exit code");
	}
}

export function assertVerificationIdentity(
	records: readonly VerificationRecord[],
	identity: VerificationIdentity,
): void {
	const canonical = records.find((record) => record.name === identity.name);
	if (!canonical || sameVerificationIdentity(canonical, identity)) return;
	throw new Error(
		`verification check ${identity.name} is already bound to a different command or cwd; use a new check name`,
	);
}

export function findReusableVerificationRecord(
	records: readonly VerificationRecord[],
	identity: VerificationIdentity,
	candidateTreeSha: string,
): VerificationRecord | null {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (
			record &&
			sameVerificationIdentity(record, identity) &&
			record.exitCode === 0 &&
			record.candidateTreeSha === candidateTreeSha
		) {
			return record;
		}
	}
	return null;
}

export function upsertVerificationRecord(
	records: readonly VerificationRecord[],
	record: VerificationRecord,
): VerificationRecord[] {
	return [...records.filter((existing) => existing.name !== record.name), record];
}

export function passingVerificationRecords(
	records: readonly VerificationRecord[],
	candidateTreeSha?: string,
): VerificationRecord[] {
	const latest = new Map<string, VerificationRecord>();
	const canonical = new Map<string, VerificationRecord>();
	for (const record of records) {
		const canonicalRecord = canonical.get(record.name);
		if (canonicalRecord === undefined) {
			canonical.set(record.name, record);
			latest.set(record.name, record);
			continue;
		}
		if (!sameVerificationIdentity(canonicalRecord, record)) continue;
		latest.set(record.name, record);
	}
	if (latest.size === 0) throw new Error("run at least one verification check before publishing");
	const failed = [...latest.values()].filter((record) => record.exitCode !== 0);
	if (failed.length > 0) {
		throw new Error(
			`verification checks are not passing: ${failed.map((record) => record.name).join(", ")}`,
		);
	}
	if (candidateTreeSha !== undefined) {
		const stale = [...latest.values()].filter(
			(record) => record.candidateTreeSha !== candidateTreeSha,
		);
		if (stale.length > 0) {
			throw new StaleVerificationError(stale.map((record) => record.name));
		}
	}
	return [...latest.values()];
}

function sameVerificationIdentity(
	left: VerificationIdentity,
	right: VerificationIdentity,
): boolean {
	return left.name === right.name && left.command === right.command && left.cwd === right.cwd;
}
