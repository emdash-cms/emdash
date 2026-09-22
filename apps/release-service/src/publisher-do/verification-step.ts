const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESULT_JSON_CHARS = 64 * 1024;
const STEP_NAMES = new Set<VerificationStepName>([
	"authoritative-profile",
	"release-absence",
	"access-baseline",
	"artifact-provenance",
	"policy-decision",
	"final-verification",
]);

export type VerificationStepName =
	| "authoritative-profile"
	| "release-absence"
	| "access-baseline"
	| "artifact-provenance"
	| "policy-decision"
	| "final-verification";

export interface StoredVerificationStep {
	name: VerificationStepName;
	inputDigest: string;
	resultJson: string;
	createdAt: number;
}

export interface PutVerificationStepInput {
	publisherDid: string;
	intentId: string;
	name: VerificationStepName;
	inputDigest: string;
	resultJson: string;
	now?: number;
}

export type PutVerificationStepResult =
	| { ok: true; step: StoredVerificationStep; replayed: boolean }
	| { ok: false; code: "INTENT_NOT_FOUND" | "INTENT_STATE_INVALID" | "VERIFICATION_STEP_CONFLICT" };

interface StepRow {
	[key: string]: string | number | ArrayBuffer | null;
	step_name: VerificationStepName;
	input_digest: string;
	result_json: string;
	created_at: number;
}

export class VerificationStepError extends Error {
	readonly code = "VERIFICATION_STEP_INPUT_INVALID";

	constructor() {
		super("VERIFICATION_STEP_INPUT_INVALID");
		this.name = "VerificationStepError";
	}
}

function validCanonicalObjectJson(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 2 || value.length > MAX_RESULT_JSON_CHARS) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			JSON.stringify(parsed) === value
		);
	} catch {
		return false;
	}
}

function rowToStep(row: StepRow): StoredVerificationStep {
	return {
		name: row.step_name,
		inputDigest: row.input_digest,
		resultJson: row.result_json,
		createdAt: row.created_at,
	};
}

export function initializeVerificationStepSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS intent_verification_steps (
			intent_id TEXT NOT NULL,
			step_name TEXT NOT NULL CHECK (step_name IN (
				'authoritative-profile', 'release-absence', 'access-baseline',
				'artifact-provenance', 'policy-decision', 'final-verification'
			)),
			input_digest TEXT NOT NULL,
			result_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (intent_id, step_name)
		);
		CREATE INDEX IF NOT EXISTS idx_intent_verification_steps_created
			ON intent_verification_steps(intent_id, created_at, step_name);
	`);
}

export class VerificationStepStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	put(input: PutVerificationStepInput): PutVerificationStepResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.intentId) ||
			!STEP_NAMES.has(input.name) ||
			!DIGEST_PATTERN.test(input.inputDigest) ||
			!validCanonicalObjectJson(input.resultJson) ||
			!Number.isSafeInteger(now) ||
			now < 0
		) {
			throw new VerificationStepError();
		}
		return this.storage.transactionSync(() => {
			const intent = this.storage.sql
				.exec<{ state: string }>("SELECT state FROM intents WHERE id = ?", input.intentId)
				.toArray()[0];
			if (!intent) return { ok: false, code: "INTENT_NOT_FOUND" } as const;
			const allowed =
				input.name === "final-verification"
					? intent.state === "ready" || intent.state === "publishing"
					: intent.state === "verifying";
			if (!allowed) return { ok: false, code: "INTENT_STATE_INVALID" } as const;
			const existing = this.#get(input.intentId, input.name);
			if (existing) {
				if (
					existing.inputDigest !== input.inputDigest ||
					existing.resultJson !== input.resultJson
				) {
					return { ok: false, code: "VERIFICATION_STEP_CONFLICT" } as const;
				}
				return { ok: true, step: existing, replayed: true } as const;
			}
			this.storage.sql.exec(
				`INSERT INTO intent_verification_steps (
					intent_id, step_name, input_digest, result_json, created_at
				) VALUES (?, ?, ?, ?, ?)`,
				input.intentId,
				input.name,
				input.inputDigest,
				input.resultJson,
				now,
			);
			this.storage.sql.exec(
				`INSERT INTO audit_events (
					event_type, actor_realm, actor_identity, subject,
					reason_code, public_payload, created_at
				) VALUES ('verification-step-recorded', 'system', 'release-service', ?, NULL, '{}', ?)`,
				`${input.intentId}:${input.name}`,
				now,
			);
			return {
				ok: true,
				step: this.#require(input.intentId, input.name),
				replayed: false,
			} as const;
		});
	}

	get(intentId: string, name: VerificationStepName): StoredVerificationStep | null {
		if (!ULID_PATTERN.test(intentId) || !STEP_NAMES.has(name)) throw new VerificationStepError();
		return this.#get(intentId, name);
	}

	list(intentId: string): readonly StoredVerificationStep[] {
		if (!ULID_PATTERN.test(intentId)) throw new VerificationStepError();
		return this.storage.sql
			.exec<StepRow>(
				`SELECT step_name, input_digest, result_json, created_at
				 FROM intent_verification_steps WHERE intent_id = ?
				 ORDER BY CASE step_name
					WHEN 'authoritative-profile' THEN 1
					WHEN 'release-absence' THEN 2
					WHEN 'access-baseline' THEN 3
					WHEN 'artifact-provenance' THEN 4
					WHEN 'policy-decision' THEN 5
					WHEN 'final-verification' THEN 6
					ELSE 7
				 END`,
				intentId,
			)
			.toArray()
			.map(rowToStep);
	}

	#require(intentId: string, name: VerificationStepName): StoredVerificationStep {
		const step = this.#get(intentId, name);
		if (!step) throw new VerificationStepError();
		return step;
	}

	#get(intentId: string, name: VerificationStepName): StoredVerificationStep | null {
		const row = this.storage.sql
			.exec<StepRow>(
				`SELECT step_name, input_digest, result_json, created_at
				 FROM intent_verification_steps WHERE intent_id = ? AND step_name = ?`,
				intentId,
				name,
			)
			.toArray()[0];
		return row ? rowToStep(row) : null;
	}
}
