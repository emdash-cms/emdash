export interface VerificationRecord {
	readonly name: string;
	readonly command: string;
	readonly exitCode: number;
	readonly candidateTreeSha: string;
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

export function passingVerificationRecords(
	records: readonly VerificationRecord[],
	candidateTreeSha?: string,
): VerificationRecord[] {
	const latest = new Map<string, VerificationRecord>();
	const commands = new Map<string, string>();
	for (const record of records) {
		const previousCommand = commands.get(record.name);
		if (previousCommand !== undefined && previousCommand !== record.command) {
			throw new Error(`verification check ${record.name} changed command between runs`);
		}
		commands.set(record.name, record.command);
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
			throw new Error(
				`candidate changed after verification checks: ${stale.map((record) => record.name).join(", ")}`,
			);
		}
	}
	return [...latest.values()];
}
