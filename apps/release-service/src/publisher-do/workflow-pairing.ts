const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;
const MAX_ACTIVE_PAIRINGS = 10;
const MAX_PAIRING_LIFETIME_MS = 30 * 60_000;
const PAIRING_RETENTION_MS = 24 * 60 * 60_000;
const encoder = new TextEncoder();

export type WorkflowPairingState = "claimed" | "confirmed" | "expired" | "pending";

export interface WorkflowPairingClaim {
	repository: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryOwnerId: string;
	repositoryVisibility: "internal" | "private" | "public";
	workflowRef: string;
	ref: string;
	environment: string | null;
}

export interface StoredWorkflowPairing {
	id: string;
	packageSlug: string;
	state: WorkflowPairingState;
	claim: WorkflowPairingClaim | null;
	expectedPolicyVersion: number | null;
	expiresAt: number;
	createdAt: number;
	claimedAt: number | null;
	confirmedAt: number | null;
}

export interface CreateWorkflowPairingInput {
	publisherDid: string;
	pairingId: string;
	pairingToken: string;
	mutationKey: string;
	packageSlug: string;
	expiresAt: number;
	now?: number;
}

export type CreateWorkflowPairingResult =
	| {
			ok: true;
			pairing: StoredWorkflowPairing;
			pairingToken: string;
			replayed: boolean;
	  }
	| { ok: false; code: "PAIRING_CONFLICT" | "PAIRING_LIMIT_REACHED" };

export interface ClaimWorkflowPairingInput {
	publisherDid: string;
	pairingId: string;
	pairingToken: string;
	claim: WorkflowPairingClaim;
	now?: number;
}

export type ClaimWorkflowPairingResult =
	| { ok: true; pairing: StoredWorkflowPairing; replayed: boolean }
	| { ok: false; code: "PAIRING_CONFLICT" | "PAIRING_EXPIRED" | "PAIRING_INVALID" };

export type PrepareWorkflowPairingConfirmationResult =
	| { ok: true; pairing: StoredWorkflowPairing; replayed: boolean }
	| { ok: false; code: "PAIRING_EXPIRED" | "PAIRING_INVALID" | "PAIRING_NOT_CLAIMED" };

interface WorkflowPairingRow {
	[key: string]: string | number | ArrayBuffer | null;
	id: string;
	mutation_key: string;
	package_slug: string;
	pairing_token: string;
	state: WorkflowPairingState;
	claim_json: string | null;
	expected_policy_version: number | null;
	expires_at: number;
	created_at: number;
	claimed_at: number | null;
	confirmed_at: number | null;
}

export class WorkflowPairingError extends Error {
	constructor() {
		super("WORKFLOW_PAIRING_INVALID");
		this.name = "WorkflowPairingError";
	}
}

function validEnvironment(value: unknown): value is string | null {
	if (value === null) return true;
	if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if (codePoint <= 31 || codePoint === 127) return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeClaim(value: unknown): WorkflowPairingClaim | null {
	if (!isRecord(value)) return null;
	const record = value;
	const keys = Object.keys(record);
	if (
		keys.length !== 8 ||
		!keys.every((key) =>
			[
				"repository",
				"repositoryId",
				"repositoryOwner",
				"repositoryOwnerId",
				"repositoryVisibility",
				"workflowRef",
				"ref",
				"environment",
			].includes(key),
		)
	) {
		return null;
	}
	const repository = record["repository"];
	const repositoryId = record["repositoryId"];
	const repositoryOwner = record["repositoryOwner"];
	const repositoryOwnerId = record["repositoryOwnerId"];
	const repositoryVisibility = record["repositoryVisibility"];
	const workflowRef = record["workflowRef"];
	const ref = record["ref"];
	const environment = record["environment"];
	if (
		typeof repository !== "string" ||
		!REPOSITORY_PATTERN.test(repository) ||
		repository !== repository.toLowerCase() ||
		typeof repositoryId !== "string" ||
		!DECIMAL_ID_PATTERN.test(repositoryId) ||
		typeof repositoryOwner !== "string" ||
		repositoryOwner.length === 0 ||
		repositoryOwner.length > 64 ||
		repositoryOwner !== repositoryOwner.toLowerCase() ||
		typeof repositoryOwnerId !== "string" ||
		!DECIMAL_ID_PATTERN.test(repositoryOwnerId) ||
		(repositoryVisibility !== "public" &&
			repositoryVisibility !== "private" &&
			repositoryVisibility !== "internal") ||
		typeof workflowRef !== "string" ||
		!WORKFLOW_REF_PATTERN.test(workflowRef) ||
		!workflowRef.toLowerCase().startsWith(`${repository}/.github/workflows/`) ||
		typeof ref !== "string" ||
		!REF_PATTERN.test(ref) ||
		!validEnvironment(environment)
	) {
		return null;
	}
	return {
		repository,
		repositoryId,
		repositoryOwner,
		repositoryOwnerId,
		repositoryVisibility,
		workflowRef,
		ref,
		environment,
	};
}

function claimsEqual(left: WorkflowPairingClaim, right: WorkflowPairingClaim): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function tokensEqual(left: string, right: string): boolean {
	if (!TOKEN_PATTERN.test(left) || !TOKEN_PATTERN.test(right)) return false;
	return crypto.subtle.timingSafeEqual(encoder.encode(left), encoder.encode(right));
}

function rowToPairing(row: WorkflowPairingRow): StoredWorkflowPairing {
	let claim: WorkflowPairingClaim | null = null;
	if (row.claim_json !== null) {
		try {
			claim = normalizeClaim(JSON.parse(row.claim_json));
		} catch {
			claim = null;
		}
		if (!claim || JSON.stringify(claim) !== row.claim_json) throw new WorkflowPairingError();
	}
	return {
		id: row.id,
		packageSlug: row.package_slug,
		state: row.state,
		claim,
		expectedPolicyVersion: row.expected_policy_version,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		claimedAt: row.claimed_at,
		confirmedAt: row.confirmed_at,
	};
}

export function initializeWorkflowPairingSchema(storage: DurableObjectStorage): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS workflow_pairings (
			id TEXT PRIMARY KEY,
			mutation_key TEXT NOT NULL UNIQUE,
			package_slug TEXT NOT NULL,
			pairing_token TEXT NOT NULL,
			state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'confirmed', 'expired')),
			claim_json TEXT,
			expected_policy_version INTEGER,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			claimed_at INTEGER,
			confirmed_at INTEGER,
			CHECK (
				(state = 'pending' AND claim_json IS NULL AND claimed_at IS NULL AND confirmed_at IS NULL)
				OR (state = 'claimed' AND claim_json IS NOT NULL AND claimed_at IS NOT NULL AND confirmed_at IS NULL)
				OR (state = 'confirmed' AND claim_json IS NOT NULL AND claimed_at IS NOT NULL AND confirmed_at IS NOT NULL)
				OR state = 'expired'
			)
		);
		CREATE INDEX IF NOT EXISTS idx_workflow_pairings_expiry
			ON workflow_pairings(state, expires_at);
	`);
}

export class WorkflowPairingStore {
	constructor(private readonly storage: DurableObjectStorage) {}

	#createRow(input: CreateWorkflowPairingInput, expectedPolicyVersion: number | null, now: number) {
		this.storage.sql.exec(
			`INSERT INTO workflow_pairings (
				id, mutation_key, package_slug, pairing_token, state, claim_json,
				expected_policy_version, expires_at, created_at, claimed_at, confirmed_at
			) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL)`,
			input.pairingId,
			input.mutationKey,
			input.packageSlug,
			input.pairingToken,
			expectedPolicyVersion,
			input.expiresAt,
			now,
		);
		return this.#read(input.pairingId)!;
	}

	#read(pairingId: string): WorkflowPairingRow | null {
		return (
			this.storage.sql
				.exec<WorkflowPairingRow>(
					`SELECT id, mutation_key, package_slug, pairing_token, state, claim_json,
					        expected_policy_version, expires_at, created_at, claimed_at, confirmed_at
					 FROM workflow_pairings WHERE id = ?`,
					pairingId,
				)
				.toArray()[0] ?? null
		);
	}

	#expire(now: number): void {
		this.storage.sql.exec(
			`UPDATE workflow_pairings SET state = 'expired'
			 WHERE state IN ('pending', 'claimed') AND expires_at <= ?`,
			now,
		);
		this.storage.sql.exec(
			"DELETE FROM workflow_pairings WHERE state IN ('confirmed', 'expired') AND expires_at <= ?",
			now - PAIRING_RETENTION_MS,
		);
	}

	create(
		input: CreateWorkflowPairingInput,
		expectedPolicyVersion: number | null,
	): CreateWorkflowPairingResult {
		const now = input.now ?? Date.now();
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.pairingId) ||
			!TOKEN_PATTERN.test(input.pairingToken) ||
			!IDEMPOTENCY_KEY_PATTERN.test(input.mutationKey) ||
			!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
			(expectedPolicyVersion !== null &&
				(!Number.isSafeInteger(expectedPolicyVersion) || expectedPolicyVersion < 1)) ||
			!Number.isSafeInteger(now) ||
			!Number.isSafeInteger(input.expiresAt) ||
			input.expiresAt <= now ||
			input.expiresAt - now > MAX_PAIRING_LIFETIME_MS
		) {
			throw new WorkflowPairingError();
		}
		return this.storage.transactionSync(() => {
			this.#expire(now);
			const existing = this.storage.sql
				.exec<WorkflowPairingRow>(
					`SELECT id, mutation_key, package_slug, pairing_token, state, claim_json,
					        expected_policy_version, expires_at, created_at, claimed_at, confirmed_at
					 FROM workflow_pairings WHERE mutation_key = ?`,
					input.mutationKey,
				)
				.toArray()[0];
			if (existing) {
				if (existing.package_slug !== input.packageSlug) {
					return { ok: false, code: "PAIRING_CONFLICT" } as const;
				}
				return {
					ok: true,
					pairing: rowToPairing(existing),
					pairingToken: existing.pairing_token,
					replayed: true,
				} as const;
			}
			const active = this.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM workflow_pairings WHERE state IN ('pending', 'claimed')",
				)
				.one().count;
			if (active >= MAX_ACTIVE_PAIRINGS) {
				return { ok: false, code: "PAIRING_LIMIT_REACHED" } as const;
			}
			const row = this.#createRow(input, expectedPolicyVersion, now);
			return {
				ok: true,
				pairing: rowToPairing(row),
				pairingToken: input.pairingToken,
				replayed: false,
			} as const;
		});
	}

	get(pairingId: string, now = Date.now()): StoredWorkflowPairing | null {
		if (!ULID_PATTERN.test(pairingId) || !Number.isSafeInteger(now)) {
			throw new WorkflowPairingError();
		}
		this.#expire(now);
		const row = this.#read(pairingId);
		return row ? rowToPairing(row) : null;
	}

	claim(input: ClaimWorkflowPairingInput): ClaimWorkflowPairingResult {
		const now = input.now ?? Date.now();
		const claim = normalizeClaim(input.claim);
		if (
			!DID_PATTERN.test(input.publisherDid) ||
			!ULID_PATTERN.test(input.pairingId) ||
			!TOKEN_PATTERN.test(input.pairingToken) ||
			!claim ||
			!Number.isSafeInteger(now)
		) {
			throw new WorkflowPairingError();
		}
		return this.storage.transactionSync(() => {
			this.#expire(now);
			const row = this.#read(input.pairingId);
			if (!row || !tokensEqual(row.pairing_token, input.pairingToken)) {
				return { ok: false, code: "PAIRING_INVALID" } as const;
			}
			if (row.state === "expired") return { ok: false, code: "PAIRING_EXPIRED" } as const;
			const current = rowToPairing(row);
			if (current.claim) {
				if (!claimsEqual(current.claim, claim)) {
					return { ok: false, code: "PAIRING_CONFLICT" } as const;
				}
				return { ok: true, pairing: current, replayed: true } as const;
			}
			this.storage.sql.exec(
				`UPDATE workflow_pairings
				 SET state = 'claimed', claim_json = ?, claimed_at = ?
				 WHERE id = ? AND state = 'pending'`,
				JSON.stringify(claim),
				now,
				input.pairingId,
			);
			return {
				ok: true,
				pairing: rowToPairing(this.#read(input.pairingId)!),
				replayed: false,
			} as const;
		});
	}

	prepareConfirmation(
		pairingId: string,
		now = Date.now(),
	): PrepareWorkflowPairingConfirmationResult {
		const pairing = this.get(pairingId, now);
		if (!pairing) return { ok: false, code: "PAIRING_INVALID" };
		if (pairing.state === "expired") return { ok: false, code: "PAIRING_EXPIRED" };
		if (pairing.state === "pending") return { ok: false, code: "PAIRING_NOT_CLAIMED" };
		return { ok: true, pairing, replayed: pairing.state === "confirmed" };
	}

	complete(pairingId: string, now = Date.now()): StoredWorkflowPairing {
		if (!ULID_PATTERN.test(pairingId) || !Number.isSafeInteger(now)) {
			throw new WorkflowPairingError();
		}
		this.storage.sql.exec(
			`UPDATE workflow_pairings SET state = 'confirmed', confirmed_at = ?
			 WHERE id = ? AND state = 'claimed'`,
			now,
			pairingId,
		);
		const row = this.#read(pairingId);
		if (!row || row.state !== "confirmed") throw new WorkflowPairingError();
		return rowToPairing(row);
	}

	expire(now: number): void {
		if (!Number.isSafeInteger(now)) throw new WorkflowPairingError();
		this.#expire(now);
	}

	nextExpiry(): number | null {
		return this.storage.sql
			.exec<{ expires_at: number | null }>(
				"SELECT MIN(expires_at) AS expires_at FROM workflow_pairings WHERE state IN ('pending', 'claimed')",
			)
			.one().expires_at;
	}
}
