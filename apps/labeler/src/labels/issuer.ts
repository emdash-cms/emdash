import {
	createListingLabelSigner,
	type CreateListingLabelSignerInput,
	type ListingLabelSigner,
} from "@emdash-cms/registry-moderation";

import {
	assertFinalizationProposal,
	type AssessmentFinalizationCommit,
	type AssessmentFinalizationIssuer,
	type AssessmentFinalizationProposal,
} from "../assessment/finalization.js";
import {
	AssessmentStateConflictError,
	createD1AssessmentLifecycleStore,
} from "../assessment/lifecycle.js";
import { isIssuancePaused, IssuancePausedError } from "../issuance-control.js";
import { labelFields, storedRowToIssuedLabel, type StoredLabelRow } from "./rows.js";
import type {
	AutomatedIssuanceContext,
	IssuedListingLabel,
	IssuedListingDecision,
	LabelPublicationTarget,
	ListingLabelIssuanceContext,
	ListingLabelProposal,
	OperatorDecisionContext,
	OperatorIssuanceContext,
	ExactListingSubject,
} from "./types.js";
import { validateListingLabelIssuance } from "./validation.js";

const OPERATOR_DECISION_LEASE_MS = 5 * 60 * 1_000;
const OPERATOR_DECISION_WAIT_MS = 10 * 1_000;

export interface CreateD1ListingLabelIssuerInput extends CreateListingLabelSignerInput {
	db: D1Database;
	automationPolicyVersions: readonly string[];
	requireObservedOperatorSubjects?: boolean;
	publicationTarget?: LabelPublicationTarget;
	onPublicationError?: (error: unknown, issued: IssuedListingLabel) => void;
}

export interface ListingLabelIssuer extends AssessmentFinalizationIssuer {
	readonly issuerDid: string;
	issue(
		context: ListingLabelIssuanceContext,
		proposal: ListingLabelProposal,
		createdAt?: Date,
	): Promise<IssuedListingLabel>;
	approve(
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
		createdAt?: Date,
	): Promise<IssuedListingDecision>;
	block(
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
		createdAt?: Date,
	): Promise<IssuedListingDecision>;
}

export async function createD1ListingLabelIssuer(
	input: CreateD1ListingLabelIssuerInput,
): Promise<ListingLabelIssuer> {
	const signer = await createListingLabelSigner(input);
	return new D1ListingLabelIssuer(
		input.db,
		signer,
		input.automationPolicyVersions,
		input.publicationTarget,
		input.onPublicationError,
		input.requireObservedOperatorSubjects ?? false,
	);
}

class D1ListingLabelIssuer implements ListingLabelIssuer {
	readonly issuerDid: string;

	constructor(
		private readonly db: D1Database,
		private readonly signer: ListingLabelSigner,
		automationPolicyVersions: readonly string[],
		private readonly publicationTarget?: LabelPublicationTarget,
		private readonly onPublicationError?: (error: unknown, issued: IssuedListingLabel) => void,
		private readonly requireObservedOperatorSubjects = false,
	) {
		this.issuerDid = signer.issuerDid;
		this.automationPolicyVersions = new Set(automationPolicyVersions);
	}

	private readonly automationPolicyVersions: ReadonlySet<string>;

	async commitAssessmentFinalization(
		proposal: AssessmentFinalizationProposal,
		createdAt = new Date(),
	): Promise<AssessmentFinalizationCommit> {
		assertFinalizationProposal(proposal);
		if (!this.automationPolicyVersions.has(proposal.policyVersion)) {
			throw new TypeError("assessment policy is not enabled for automated issuance");
		}
		const summaryJson = JSON.stringify({
			schemaVersion: 1,
			policyEngineVersion: proposal.resolution.policyEngineVersion,
			reasonCodes: proposal.resolution.reasonCodes,
			textIdentity: proposal.resolution.textIdentity,
			imageIdentities: proposal.resolution.imageIdentities,
		});
		const coverageJson = JSON.stringify(proposal.resolution.coverage);
		assertBoundedFinalizationJson(summaryJson, coverageJson);
		const completedAt = createdAt.toISOString();
		if (await this.hasManualDecision(proposal.subject.uri, proposal.subject.cid)) {
			return this.commitManualProtectedFinalization(
				proposal,
				coverageJson,
				summaryJson,
				completedAt,
			);
		}
		if (await isIssuancePaused(this.db)) {
			throw new IssuancePausedError("automated label issuance is paused");
		}
		const context: AutomatedIssuanceContext = {
			actorDid: this.signer.issuerDid,
			role: "automation",
			assessmentId: proposal.assessmentId,
			policyVersion: proposal.policyVersion,
			outcome: proposal.outcome,
			reason: proposal.reason,
			idempotencyKey: proposal.idempotencyKey,
		};
		const validated = validateListingLabelIssuance(
			this.signer.issuerDid,
			context,
			proposal.label,
			createdAt,
		);
		const existing = await this.readByIdempotencyKey(proposal.idempotencyKey);
		if (existing) {
			this.assertStoredRequestMatches(existing, context, proposal.label);
			return this.finalizationCommit(proposal, await this.publishBestEffort(existing));
		}

		const signed = await this.signer.sign(validated.label);
		const signingKeyId = `${this.signer.issuerDid}#atproto_label`;
		const statements = [
			this.finalizationUpdate(proposal, coverageJson, summaryJson, completedAt, false),
			this.finalizationLabelInsert(context, proposal, signed, signingKeyId, createdAt),
			...proposal.resolution.findings.map((finding, index) =>
				this.finalizationFindingInsert(proposal, finding, index, completedAt),
			),
		];
		try {
			await this.db.batch(statements);
		} catch (error) {
			const concurrent = await this.readByIdempotencyKey(proposal.idempotencyKey);
			if (!concurrent) {
				await this.throwFinalizationConflict(proposal, error);
				throw error;
			}
			this.assertStoredRequestMatches(concurrent, context, proposal.label);
			return this.finalizationCommit(proposal, await this.publishBestEffort(concurrent));
		}

		const issued = await this.readByIdempotencyKey(proposal.idempotencyKey);
		if (!issued) {
			await this.throwFinalizationConflict(proposal);
			throw new Error("assessment finalization committed without its signed label");
		}
		this.assertStoredRequestMatches(issued, context, proposal.label);
		return this.finalizationCommit(proposal, await this.publishBestEffort(issued));
	}

	async issue(
		context: ListingLabelIssuanceContext,
		proposal: ListingLabelProposal,
		createdAt = new Date(),
	): Promise<IssuedListingLabel> {
		const issuanceTime =
			context.role !== "automation" && context.operatorAction.action === "retract-takedown"
				? await this.strictlyLaterLabelTime(proposal.subject.uri, proposal.value, createdAt)
				: createdAt;
		const validated = validateListingLabelIssuance(
			this.signer.issuerDid,
			context,
			proposal,
			issuanceTime,
		);
		if (
			context.role !== "automation" &&
			(context.operatorAction.action === "approve" || context.operatorAction.action === "block")
		) {
			throw new TypeError("approve and block labels must use the decision-level methods");
		}
		if (
			context.role === "automation" &&
			!this.automationPolicyVersions.has(context.policyVersion)
		) {
			throw new TypeError("assessment policy is not enabled for automated issuance");
		}
		if (context.role === "automation" && (await isIssuancePaused(this.db))) {
			throw new IssuancePausedError("automated label issuance is paused");
		}
		const existing = await this.readByIdempotencyKey(context.idempotencyKey);
		if (existing) {
			this.assertStoredRequestMatches(existing, context, proposal);
			return this.publishBestEffort(existing);
		}
		if (context.role === "automation") {
			await this.assertAutomatedIssuanceAllowed(context, proposal);
		}

		const signed = await this.signer.sign(validated.label);
		const signingKeyId = `${this.signer.issuerDid}#atproto_label`;
		const statements =
			context.role === "automation"
				? [this.automatedInsert(context, signed, signingKeyId, issuanceTime)]
				: this.operatorInserts(
						context,
						proposal,
						signed,
						signingKeyId,
						issuanceTime,
						context.operatorAction.action === "retract-takedown",
					);
		try {
			await this.db.batch(statements);
		} catch (error) {
			const concurrent = await this.readByIdempotencyKey(context.idempotencyKey);
			if (!concurrent) throw error;
			this.assertStoredRequestMatches(concurrent, context, proposal);
			return this.publishBestEffort(concurrent);
		}

		const issued = await this.readByIdempotencyKey(context.idempotencyKey);
		if (!issued) {
			if (context.role === "automation") {
				await this.assertAutomatedIssuanceAllowed(context, proposal);
			}
			throw new TypeError("idempotency key is bound to an incompatible operator action");
		}
		this.assertStoredRequestMatches(issued, context, proposal);
		return this.publishBestEffort(issued);
	}

	private async strictlyLaterLabelTime(uri: string, value: string, requested: Date): Promise<Date> {
		const latest = await this.db
			.prepare("SELECT MAX(cts) AS cts FROM issued_labels WHERE src = ? AND uri = ? AND val = ?")
			.bind(this.signer.issuerDid, uri, value)
			.first<string>("cts");
		if (!latest) return requested;
		const latestTime = Date.parse(latest);
		if (Number.isNaN(latestTime)) throw new Error("stored label timestamp is invalid");
		return requested.getTime() > latestTime ? requested : new Date(latestTime + 1);
	}

	approve(
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
		createdAt = new Date(),
	): Promise<IssuedListingDecision> {
		return this.issueDecision("approve", context, subject, createdAt, [
			{ value: "listing-passed" },
			{ value: "listing-overridden" },
			{ value: "listing-review", negate: true },
			{ value: "listing-error", negate: true },
			{ value: "listing-blocked", negate: true },
		]);
	}

	block(
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
		createdAt = new Date(),
	): Promise<IssuedListingDecision> {
		return this.issueDecision("block", context, subject, createdAt, [
			{ value: "listing-blocked" },
			{ value: "listing-passed", negate: true },
			{ value: "listing-overridden", negate: true },
		]);
	}

	private async issueDecision(
		action: "approve" | "block",
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
		createdAt: Date,
		transitions: readonly {
			value:
				| "listing-passed"
				| "listing-overridden"
				| "listing-review"
				| "listing-error"
				| "listing-blocked";
			negate?: boolean;
		}[],
	): Promise<IssuedListingDecision> {
		const existingDecision = await this.readExistingDecision(action, context, subject);
		if (existingDecision) return this.publishDecision(action, existingDecision);
		const leaseToken = await this.acquireOperatorDecisionLease(subject, createdAt);
		try {
			const concurrentDecision = await this.readExistingDecision(action, context, subject);
			if (concurrentDecision) return this.publishDecision(action, concurrentDecision);
			const decisionTime = await this.strictlyLaterDecisionTime(subject, createdAt);
			const applicableTransitions = [];
			for (const transition of transitions) {
				if (
					transition.negate !== true ||
					(await this.isCurrentActiveExactLabel(subject, transition.value, decisionTime))
				) {
					applicableTransitions.push(transition);
				}
			}
			const prepared = await Promise.all(
				applicableTransitions.map(async (transition, index) => {
					const issuanceContext: OperatorIssuanceContext = {
						...context,
						idempotencyKey: `${context.idempotencyKey}:label:${index}`,
						operatorAction: { action, idempotencyKey: context.idempotencyKey },
					};
					const proposal: ListingLabelProposal = {
						subject,
						value: transition.value,
						...(transition.negate === true ? { negate: true } : {}),
					};
					const validated = validateListingLabelIssuance(
						this.signer.issuerDid,
						issuanceContext,
						proposal,
						decisionTime,
					);
					return {
						issuanceContext,
						proposal,
						label: await this.signer.sign(validated.label),
					};
				}),
			);
			const signingKeyId = `${this.signer.issuerDid}#atproto_label`;
			const statementGroups = prepared.map(({ issuanceContext, proposal, label }) =>
				this.operatorInserts(
					issuanceContext,
					proposal,
					label,
					signingKeyId,
					decisionTime,
					proposal.negate === true,
					leaseToken,
				),
			);
			const firstGroup = statementGroups[0];
			if (!firstGroup) throw new Error("operator decision has no label transitions");
			const statements = [firstGroup[0]!, ...statementGroups.map((group) => group[1]!)];
			try {
				await this.db.batch(statements);
			} catch (error) {
				const existing = await this.readExistingDecision(action, context, subject);
				if (!existing) throw error;
				return this.publishDecision(action, existing);
			}
			const issued = await this.readDecision(prepared);
			if (!issued) {
				throw new TypeError("operator idempotency key is bound to an incompatible decision");
			}
			return this.publishDecision(action, issued);
		} finally {
			await this.releaseOperatorDecisionLease(subject, leaseToken);
		}
	}

	private async acquireOperatorDecisionLease(
		subject: ExactListingSubject,
		now: Date,
	): Promise<string> {
		const leaseToken = crypto.randomUUID();
		const nowIso = now.toISOString();
		const expiresAt = new Date(now.getTime() + OPERATOR_DECISION_LEASE_MS).toISOString();
		const waitUntil = Date.now() + OPERATOR_DECISION_WAIT_MS;
		for (;;) {
			const acquired = await this.db
				.prepare(
					`INSERT INTO operator_decision_leases
					   (subject_uri, subject_cid, lease_token, lease_expires_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(subject_uri, subject_cid) DO UPDATE SET
					   lease_token = excluded.lease_token,
					   lease_expires_at = excluded.lease_expires_at
					 WHERE operator_decision_leases.lease_expires_at <= ?`,
				)
				.bind(subject.uri, subject.cid, leaseToken, expiresAt, nowIso)
				.run();
			if (acquired.meta.changes === 1) return leaseToken;
			if (Date.now() >= waitUntil) {
				throw new TypeError("another operator decision is in progress for this subject");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	private async releaseOperatorDecisionLease(
		subject: ExactListingSubject,
		leaseToken: string,
	): Promise<void> {
		await this.db
			.prepare(
				`DELETE FROM operator_decision_leases
				 WHERE subject_uri = ? AND subject_cid = ? AND lease_token = ?`,
			)
			.bind(subject.uri, subject.cid, leaseToken)
			.run();
	}

	private async strictlyLaterDecisionTime(
		subject: ExactListingSubject,
		requested: Date,
	): Promise<Date> {
		const latest = await this.db
			.prepare(
				`SELECT MAX(cts) AS cts FROM issued_labels
				 WHERE src = ? AND uri = ? AND cid = ?
				   AND val IN ('listing-passed', 'listing-overridden', 'listing-review',
				               'listing-error', 'listing-blocked')`,
			)
			.bind(this.signer.issuerDid, subject.uri, subject.cid)
			.first<string>("cts");
		if (!latest) return requested;
		const latestTime = Date.parse(latest);
		if (Number.isNaN(latestTime)) throw new Error("stored decision label timestamp is invalid");
		return requested.getTime() > latestTime ? requested : new Date(latestTime + 1);
	}

	private async readExistingDecision(
		action: "approve" | "block",
		context: OperatorDecisionContext,
		subject: ExactListingSubject,
	): Promise<IssuedListingLabel[] | null> {
		const storedAction = await this.db
			.prepare(
				`SELECT id, actor_did, actor_role, action, subject_uri, subject_cid, reason
				 FROM operator_actions WHERE idempotency_key = ?`,
			)
			.bind(context.idempotencyKey)
			.first<{
				id: number;
				actor_did: string;
				actor_role: string;
				action: string;
				subject_uri: string | null;
				subject_cid: string | null;
				reason: string;
			}>();
		if (!storedAction) return null;
		if (
			storedAction.actor_did !== context.actorDid ||
			storedAction.actor_role !== context.role ||
			storedAction.action !== action ||
			storedAction.subject_uri !== subject.uri ||
			storedAction.subject_cid !== subject.cid ||
			storedAction.reason !== context.reason
		) {
			throw new TypeError("operator idempotency key is already bound to a different decision");
		}
		const labels = await this.readLabelsByOperatorAction(storedAction.id);
		if (labels.length === 0) throw new Error("operator decision has no committed labels");
		return labels;
	}

	private async readDecision(
		prepared: readonly {
			issuanceContext: OperatorIssuanceContext;
			proposal: ListingLabelProposal;
		}[],
	): Promise<IssuedListingLabel[] | null> {
		const labels: IssuedListingLabel[] = [];
		for (const item of prepared) {
			const stored = await this.readByIdempotencyKey(item.issuanceContext.idempotencyKey);
			if (!stored) return null;
			this.assertStoredRequestMatches(stored, item.issuanceContext, item.proposal);
			labels.push(stored);
		}
		const actionIds = new Set(labels.map((label) => label.operatorActionId));
		if (actionIds.size !== 1 || actionIds.has(undefined)) {
			throw new Error("operator decision labels do not share one action");
		}
		return labels;
	}

	private async publishDecision(
		action: "approve" | "block",
		labels: readonly IssuedListingLabel[],
	): Promise<IssuedListingDecision> {
		for (const label of labels) await this.publishBestEffort(label);
		const operatorActionId = labels[0]?.operatorActionId;
		if (operatorActionId === undefined) throw new Error("operator decision has no action id");
		const refreshed = await this.readLabelsByOperatorAction(operatorActionId);
		return { action, operatorActionId, labels: refreshed };
	}

	private finalizationUpdate(
		proposal: AssessmentFinalizationProposal,
		coverageJson: string,
		summaryJson: string,
		completedAt: string,
		allowManualDecision: boolean,
	): D1PreparedStatement {
		return this.db
			.prepare(
				`UPDATE assessments SET
				   state = ?,
				   state_version = state_version + 1,
				   coverage_json = ?,
				   summary_json = ?,
				   finalization_idempotency_key = ?,
				   updated_at = ?,
				   completed_at = ?
				 WHERE id = ? AND run_key = ?
				   AND subject_uri = ? AND subject_cid = ? AND subject_kind = ?
				   AND policy_version = ?
				   AND state = 'running' AND state_version = ?
				   AND moderation_fingerprint = ?
				   AND EXISTS (
				     SELECT 1 FROM current_assessments current
				     WHERE current.subject_uri = assessments.subject_uri
				       AND current.subject_cid = assessments.subject_cid
				       AND current.assessment_id = assessments.id
				   )
				   AND EXISTS (
				     SELECT 1
				     FROM current_subjects current
				     JOIN subjects subject
				       ON subject.uri = current.uri AND subject.cid = current.cid
				     WHERE current.uri = assessments.subject_uri
				       AND current.cid = assessments.subject_cid
				       AND current.deleted_at IS NULL
				       AND subject.deleted_at IS NULL
				   )
				   AND (? = 1 OR NOT EXISTS (
				     SELECT 1 FROM operator_actions protected
				     WHERE protected.subject_uri = assessments.subject_uri
				       AND protected.subject_cid = assessments.subject_cid
				       AND protected.action IN ('approve', 'block')
				   ))
				   AND (? = 1 OR NOT EXISTS (
				     SELECT 1 FROM service_state pause
				     WHERE pause.key = 'issuance_paused' AND pause.value = '1'
				   ))`,
			)
			.bind(
				proposal.outcome,
				coverageJson,
				summaryJson,
				proposal.idempotencyKey,
				completedAt,
				completedAt,
				proposal.assessmentId,
				proposal.runKey,
				proposal.subject.uri,
				proposal.subject.cid,
				proposal.subject.kind,
				proposal.policyVersion,
				proposal.expectedStateVersion,
				proposal.moderationFingerprint,
				allowManualDecision ? 1 : 0,
				allowManualDecision ? 1 : 0,
			);
	}

	private async hasManualDecision(uri: string, cid: string): Promise<boolean> {
		const row = await this.db
			.prepare(
				`SELECT id FROM operator_actions
				 WHERE subject_uri = ? AND subject_cid = ?
				   AND action IN ('approve', 'block')
				 LIMIT 1`,
			)
			.bind(uri, cid)
			.first();
		return row !== null;
	}

	private async commitManualProtectedFinalization(
		proposal: AssessmentFinalizationProposal,
		coverageJson: string,
		summaryJson: string,
		completedAt: string,
	): Promise<AssessmentFinalizationCommit> {
		const existing = await this.readManualProtectedFinalization(proposal);
		if (existing) return existing;
		try {
			await this.db.batch([
				this.finalizationUpdate(proposal, coverageJson, summaryJson, completedAt, true),
				...proposal.resolution.findings.map((finding, index) =>
					this.finalizationFindingInsert(proposal, finding, index, completedAt),
				),
			]);
		} catch (error) {
			const concurrent = await this.readManualProtectedFinalization(proposal);
			if (concurrent) return concurrent;
			throw error;
		}
		const committed = await this.readManualProtectedFinalization(proposal);
		if (!committed) throw new AssessmentStateConflictError(proposal.runKey);
		return committed;
	}

	private async readManualProtectedFinalization(
		proposal: AssessmentFinalizationProposal,
	): Promise<AssessmentFinalizationCommit | null> {
		const run = await createD1AssessmentLifecycleStore(this.db).getRun(proposal.runKey);
		if (
			!run ||
			run.state !== proposal.outcome ||
			run.stateVersion !== proposal.expectedStateVersion + 1 ||
			run.subject.uri !== proposal.subject.uri ||
			run.subject.cid !== proposal.subject.cid
		) {
			return null;
		}
		const finalizationKey = await this.db
			.prepare("SELECT finalization_idempotency_key FROM assessments WHERE run_key = ?")
			.bind(proposal.runKey)
			.first<string>("finalization_idempotency_key");
		return finalizationKey === proposal.idempotencyKey ? { run, publicationPending: false } : null;
	}

	private finalizationLabelInsert(
		context: AutomatedIssuanceContext,
		proposal: AssessmentFinalizationProposal,
		label: Awaited<ReturnType<ListingLabelSigner["sign"]>>,
		signingKeyId: string,
		createdAt: Date,
	): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO issued_labels (
					idempotency_key, assessment_id, assessment_policy_version,
					assessment_outcome, operator_action_id, actor_did, actor_role,
					reason, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
					publication_pending, created_at
				)
				VALUES (
					?, COALESCE((
						SELECT assessment.id
						FROM assessments assessment
						JOIN subjects subject
						  ON subject.uri = assessment.subject_uri
						 AND subject.cid = assessment.subject_cid
						JOIN current_subjects current_subject
						  ON current_subject.uri = assessment.subject_uri
						 AND current_subject.cid = assessment.subject_cid
						JOIN current_assessments current_assessment
						  ON current_assessment.subject_uri = assessment.subject_uri
						 AND current_assessment.subject_cid = assessment.subject_cid
						 AND current_assessment.assessment_id = assessment.id
						WHERE assessment.id = ? AND assessment.run_key = ?
						  AND assessment.subject_uri = ? AND assessment.subject_cid = ?
						  AND assessment.subject_kind = ? AND assessment.policy_version = ?
						  AND assessment.state = ? AND assessment.state_version = ?
						  AND assessment.moderation_fingerprint = ?
						  AND assessment.finalization_idempotency_key = ?
						  AND subject.deleted_at IS NULL
						  AND current_subject.deleted_at IS NULL
						  AND NOT EXISTS (
							SELECT 1 FROM service_state pause
							WHERE pause.key = 'issuance_paused' AND pause.value = '1'
						  )
						  AND NOT EXISTS (
							SELECT 1 FROM operator_actions protected
							WHERE protected.subject_uri = assessment.subject_uri
							  AND protected.subject_cid = assessment.subject_cid
							  AND protected.action IN ('approve', 'block')
						  )
					), ''), ?, ?, NULL, ?, 'automation',
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
				)`,
			)
			.bind(
				context.idempotencyKey,
				proposal.assessmentId,
				proposal.runKey,
				proposal.subject.uri,
				proposal.subject.cid,
				proposal.subject.kind,
				proposal.policyVersion,
				proposal.outcome,
				proposal.expectedStateVersion + 1,
				proposal.moderationFingerprint,
				proposal.idempotencyKey,
				proposal.policyVersion,
				proposal.outcome,
				context.actorDid,
				context.reason,
				...labelFields(label),
				signingKeyId,
				createdAt.toISOString(),
			);
	}

	private finalizationFindingInsert(
		proposal: AssessmentFinalizationProposal,
		finding: AssessmentFinalizationProposal["resolution"]["findings"][number],
		index: number,
		createdAt: string,
	): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO findings (
					assessment_id, finding_index, category, confidence, reason_code,
					public_summary, evidence_refs_json, created_at
				)
				SELECT id, ?, ?, ?, ?, ?, ?, ?
				FROM assessments
				WHERE id = ? AND run_key = ?
				  AND state = ? AND state_version = ?
				  AND moderation_fingerprint = ?
				  AND finalization_idempotency_key = ?`,
			)
			.bind(
				index,
				finding.category,
				finding.confidence,
				proposal.resolution.reasonCodes[0] ?? "policy-finding",
				finding.summary,
				JSON.stringify(finding.evidenceRefs),
				createdAt,
				proposal.assessmentId,
				proposal.runKey,
				proposal.outcome,
				proposal.expectedStateVersion + 1,
				proposal.moderationFingerprint,
				proposal.idempotencyKey,
			);
	}

	private async finalizationCommit(
		proposal: AssessmentFinalizationProposal,
		issued: IssuedListingLabel,
	): Promise<AssessmentFinalizationCommit> {
		const run = await createD1AssessmentLifecycleStore(this.db).getRun(proposal.runKey);
		if (
			!run ||
			run.state !== proposal.outcome ||
			run.stateVersion !== proposal.expectedStateVersion + 1 ||
			run.subject.uri !== proposal.subject.uri ||
			run.subject.cid !== proposal.subject.cid
		) {
			throw new Error("assessment finalization issuer returned a mismatched commit");
		}
		const finalizationKey = await this.db
			.prepare("SELECT finalization_idempotency_key FROM assessments WHERE run_key = ?")
			.bind(proposal.runKey)
			.first<string>("finalization_idempotency_key");
		if (finalizationKey !== proposal.idempotencyKey) {
			throw new Error("assessment finalization is not bound to its signed label");
		}
		return {
			run,
			labelSequence: issued.sequence,
			publicationPending: issued.publicationPending,
		};
	}

	private async throwFinalizationConflict(
		proposal: AssessmentFinalizationProposal,
		cause?: unknown,
	): Promise<never> {
		const protectedDecision = await this.db
			.prepare(
				`SELECT id FROM operator_actions
				 WHERE subject_uri = ? AND subject_cid = ?
				   AND action IN ('approve', 'block')
				 LIMIT 1`,
			)
			.bind(proposal.subject.uri, proposal.subject.cid)
			.first();
		if (protectedDecision) {
			throw new TypeError(
				"assessment is not authorized for this subject, outcome, policy, or manual-decision state",
			);
		}
		const eligible = await this.db
			.prepare(
				`SELECT assessment.id
				 FROM assessments assessment
				 JOIN subjects subject
				   ON subject.uri = assessment.subject_uri AND subject.cid = assessment.subject_cid
				 JOIN current_subjects current_subject
				   ON current_subject.uri = assessment.subject_uri
				  AND current_subject.cid = assessment.subject_cid
				 JOIN current_assessments current_assessment
				   ON current_assessment.subject_uri = assessment.subject_uri
				  AND current_assessment.subject_cid = assessment.subject_cid
				  AND current_assessment.assessment_id = assessment.id
				 WHERE assessment.id = ? AND assessment.run_key = ?
				   AND assessment.subject_uri = ? AND assessment.subject_cid = ?
				   AND assessment.policy_version = ?
				   AND assessment.state = 'running' AND assessment.state_version = ?
				   AND assessment.moderation_fingerprint = ?
				   AND subject.deleted_at IS NULL AND current_subject.deleted_at IS NULL`,
			)
			.bind(
				proposal.assessmentId,
				proposal.runKey,
				proposal.subject.uri,
				proposal.subject.cid,
				proposal.policyVersion,
				proposal.expectedStateVersion,
				proposal.moderationFingerprint,
			)
			.first();
		if (eligible && cause !== undefined) throw cause;
		throw new AssessmentStateConflictError(proposal.runKey);
	}

	private automatedInsert(
		context: Extract<ListingLabelIssuanceContext, { role: "automation" }>,
		label: Awaited<ReturnType<ListingLabelSigner["sign"]>>,
		signingKeyId: string,
		createdAt: Date,
	): D1PreparedStatement {
		return this.db
			.prepare(
				`INSERT INTO issued_labels (
					idempotency_key, assessment_id, assessment_policy_version,
					assessment_outcome, operator_action_id, actor_did, actor_role,
					reason, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
					publication_pending, created_at
				)
				SELECT ?, assessment.id, assessment.policy_version, ?, NULL, ?, 'automation',
				       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
				FROM assessments assessment
				JOIN subjects subject
				  ON subject.uri = assessment.subject_uri AND subject.cid = assessment.subject_cid
				JOIN current_assessments current_assessment
				  ON current_assessment.subject_uri = assessment.subject_uri
				 AND current_assessment.subject_cid = assessment.subject_cid
				 AND current_assessment.assessment_id = assessment.id
				LEFT JOIN current_subjects current_subject
				  ON current_subject.uri = assessment.subject_uri
				WHERE assessment.id = ?
				  AND assessment.subject_uri = ?
				  AND assessment.subject_cid = ?
				  AND assessment.policy_version = ?
				  AND (
					(? = 'pending' AND assessment.state IN ('pending', 'running'))
					OR (? <> 'pending' AND assessment.state = ?)
				  )
				  AND subject.deleted_at IS NULL
				  AND NOT EXISTS (
					SELECT 1 FROM service_state pause
					WHERE pause.key = 'issuance_paused' AND pause.value = '1'
				  )
				  AND (
					? = 1
					OR (
						current_subject.cid = assessment.subject_cid
						AND current_subject.deleted_at IS NULL
					)
				  )
				  AND NOT EXISTS (
					SELECT 1 FROM operator_actions protected
					WHERE protected.subject_uri = assessment.subject_uri
					  AND protected.subject_cid = assessment.subject_cid
					  AND protected.action IN ('approve', 'block')
				)
				`,
			)
			.bind(
				context.idempotencyKey,
				context.outcome,
				context.actorDid,
				context.reason,
				...labelFields(label),
				signingKeyId,
				createdAt.toISOString(),
				context.assessmentId,
				label.uri,
				label.cid,
				context.policyVersion,
				context.outcome,
				context.outcome,
				context.outcome,
				label.neg === true ? 1 : 0,
			);
	}

	private operatorInserts(
		context: OperatorIssuanceContext,
		proposal: ListingLabelProposal,
		label: Awaited<ReturnType<ListingLabelSigner["sign"]>>,
		signingKeyId: string,
		createdAt: Date,
		requireCurrentExactPositive = false,
		decisionLeaseToken?: string,
	): D1PreparedStatement[] {
		const subjectCid = proposal.value === "!takedown" ? null : proposal.subject.cid;
		const requireObservedSubject =
			this.requireObservedOperatorSubjects && proposal.value !== "!takedown";
		const action = this.db
			.prepare(
				`INSERT INTO operator_actions (
					actor_did, actor_role, action, subject_uri, subject_cid, reason,
					idempotency_key, created_at
				)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE ? IS NULL OR EXISTS (
					SELECT 1 FROM operator_decision_leases lease
					WHERE lease.subject_uri = ? AND lease.subject_cid = ?
					  AND lease.lease_token = ?
				)
				ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				context.actorDid,
				context.role,
				context.operatorAction.action,
				proposal.subject.uri,
				subjectCid,
				context.reason,
				context.operatorAction.idempotencyKey,
				createdAt.toISOString(),
				decisionLeaseToken ?? null,
				proposal.subject.uri,
				subjectCid,
				decisionLeaseToken ?? null,
			);
		const issued = this.db
			.prepare(
				`INSERT INTO issued_labels (
					idempotency_key, assessment_id, assessment_policy_version,
					assessment_outcome, operator_action_id, actor_did, actor_role,
					reason, ver, src, uri, cid, val, neg, cts, exp, sig, signing_key_id,
					publication_pending, created_at
				)
				VALUES (
					?, NULL, NULL, NULL,
					COALESCE((
						SELECT id FROM operator_actions
						WHERE idempotency_key = ?
						  AND actor_did = ?
						  AND actor_role = ?
						  AND action = ?
						  AND subject_uri = ?
						  AND subject_cid IS ?
							  AND reason = ?
							  AND (
								? = 0
								OR EXISTS (
									SELECT 1
									FROM subjects observed
									JOIN current_subjects current ON current.uri = observed.uri
									WHERE observed.uri = ? AND observed.cid IS ?
									  AND observed.deleted_at IS NULL
									  AND current.cid IS observed.cid
									  AND current.deleted_at IS NULL
								)
							  )
							  AND (
							? = 0
							OR EXISTS (
								SELECT 1 FROM issued_labels winning
								WHERE winning.src = ? AND winning.uri = ? AND winning.val = ?
								  AND winning.cts = (
									SELECT MAX(maximum.cts) FROM issued_labels maximum
									WHERE maximum.src = ? AND maximum.uri = ? AND maximum.val = ?
								  )
								  AND winning.neg = 0
								  AND winning.cid IS ?
								  AND (winning.exp IS NULL OR julianday(winning.exp) > julianday(?))
								  AND NOT EXISTS (
									SELECT 1 FROM issued_labels collision
									WHERE collision.src = ? AND collision.uri = ? AND collision.val = ?
									  AND collision.cts = winning.cts
									  AND (
										collision.cid IS NOT winning.cid
										OR collision.neg IS NOT winning.neg
										OR collision.exp IS NOT winning.exp
									  )
								  )
							)
						  )
					), -1),
					?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
				)`,
			)
			.bind(
				context.idempotencyKey,
				context.operatorAction.idempotencyKey,
				context.actorDid,
				context.role,
				context.operatorAction.action,
				proposal.subject.uri,
				subjectCid,
				context.reason,
				requireObservedSubject ? 1 : 0,
				proposal.subject.uri,
				subjectCid,
				requireCurrentExactPositive ? 1 : 0,
				this.signer.issuerDid,
				proposal.subject.uri,
				proposal.value,
				this.signer.issuerDid,
				proposal.subject.uri,
				proposal.value,
				subjectCid,
				createdAt.toISOString(),
				this.signer.issuerDid,
				proposal.subject.uri,
				proposal.value,
				context.actorDid,
				context.role,
				context.reason,
				...labelFields(label),
				signingKeyId,
				createdAt.toISOString(),
			);
		return [action, issued];
	}

	private async isCurrentActiveExactLabel(
		subject: ExactListingSubject,
		value: string,
		evaluatedAt: Date,
	): Promise<boolean> {
		const row = await this.db
			.prepare(
				`SELECT EXISTS (
					SELECT 1 FROM issued_labels winning
					WHERE winning.src = ? AND winning.uri = ? AND winning.val = ?
					  AND winning.cts = (
						SELECT MAX(maximum.cts) FROM issued_labels maximum
						WHERE maximum.src = ? AND maximum.uri = ? AND maximum.val = ?
					  )
					  AND winning.neg = 0
					  AND winning.cid IS ?
					  AND (winning.exp IS NULL OR julianday(winning.exp) > julianday(?))
					  AND NOT EXISTS (
						SELECT 1 FROM issued_labels collision
						WHERE collision.src = ? AND collision.uri = ? AND collision.val = ?
						  AND collision.cts = winning.cts
						  AND (
							collision.cid IS NOT winning.cid
							OR collision.neg IS NOT winning.neg
							OR collision.exp IS NOT winning.exp
						  )
					  )
				) AS active`,
			)
			.bind(
				this.signer.issuerDid,
				subject.uri,
				value,
				this.signer.issuerDid,
				subject.uri,
				value,
				subject.cid,
				evaluatedAt.toISOString(),
				this.signer.issuerDid,
				subject.uri,
				value,
			)
			.first<{ active: number }>();
		return row?.active === 1;
	}

	private async readLabelsByOperatorAction(actionId: number): Promise<IssuedListingLabel[]> {
		const result = await this.db
			.prepare(
				`SELECT l.id, l.idempotency_key, l.assessment_id,
				 l.assessment_policy_version, l.assessment_outcome, l.operator_action_id,
				 l.actor_did, l.actor_role, l.reason, l.sequence, l.ver, l.src, l.uri,
				 l.cid, l.val, l.neg, l.cts, l.exp, l.sig, l.signing_key_id,
				 l.publication_pending, a.action AS operator_action,
				 a.idempotency_key AS operator_idempotency_key
				 FROM issued_labels l
				 JOIN operator_actions a ON a.id = l.operator_action_id
				 WHERE l.operator_action_id = ?
				 ORDER BY l.sequence ASC`,
			)
			.bind(actionId)
			.all<StoredLabelRow>();
		return (result.results ?? []).map(storedRowToIssuedLabel);
	}

	private async readByIdempotencyKey(key: string): Promise<IssuedListingLabel | null> {
		const row = await this.db
			.prepare(
				`SELECT l.id, l.idempotency_key, l.assessment_id,
				 l.assessment_policy_version, l.assessment_outcome, l.operator_action_id,
				 l.actor_did, l.actor_role, l.reason, l.sequence, l.ver, l.src, l.uri,
				 l.cid, l.val, l.neg, l.cts, l.exp, l.sig, l.signing_key_id,
				 l.publication_pending, a.action AS operator_action,
				 a.idempotency_key AS operator_idempotency_key
				 FROM issued_labels l
				 LEFT JOIN operator_actions a ON a.id = l.operator_action_id
				 WHERE l.idempotency_key = ?`,
			)
			.bind(key)
			.first<StoredLabelRow>();
		return row ? storedRowToIssuedLabel(row) : null;
	}

	private async assertAutomatedIssuanceAllowed(
		context: Extract<ListingLabelIssuanceContext, { role: "automation" }>,
		proposal: ListingLabelProposal,
	): Promise<void> {
		const authorized = await this.db
			.prepare(
				`SELECT assessment.id
				 FROM assessments assessment
				 JOIN subjects subject
				   ON subject.uri = assessment.subject_uri AND subject.cid = assessment.subject_cid
				 JOIN current_assessments current_assessment
				   ON current_assessment.subject_uri = assessment.subject_uri
				  AND current_assessment.subject_cid = assessment.subject_cid
				  AND current_assessment.assessment_id = assessment.id
				 LEFT JOIN current_subjects current_subject
				   ON current_subject.uri = assessment.subject_uri
				 WHERE assessment.id = ?
				   AND assessment.subject_uri = ?
				   AND assessment.subject_cid = ?
				   AND assessment.policy_version = ?
				   AND (
					(? = 'pending' AND assessment.state IN ('pending', 'running'))
					OR (? <> 'pending' AND assessment.state = ?)
				   )
				   AND subject.deleted_at IS NULL
				   AND NOT EXISTS (
					SELECT 1 FROM service_state pause
					WHERE pause.key = 'issuance_paused' AND pause.value = '1'
				   )
				   AND (
					? = 1
					OR (
						current_subject.cid = assessment.subject_cid
						AND current_subject.deleted_at IS NULL
					)
				   )
				   AND NOT EXISTS (
					SELECT 1 FROM operator_actions protected
					WHERE protected.subject_uri = assessment.subject_uri
					  AND protected.subject_cid = assessment.subject_cid
					  AND protected.action IN ('approve', 'block')
				   )`,
			)
			.bind(
				context.assessmentId,
				proposal.subject.uri,
				proposal.value === "!takedown" ? null : proposal.subject.cid,
				context.policyVersion,
				context.outcome,
				context.outcome,
				context.outcome,
				proposal.negate === true ? 1 : 0,
			)
			.first<{ id: string }>();
		if (!authorized) {
			throw new TypeError(
				"assessment is not authorized for this subject, outcome, policy, or manual-decision state",
			);
		}
	}

	private assertStoredRequestMatches(
		stored: IssuedListingLabel,
		context: ListingLabelIssuanceContext,
		proposal: ListingLabelProposal,
	): void {
		const cid = proposal.value === "!takedown" ? undefined : proposal.subject.cid;
		if (
			stored.actorDid !== context.actorDid ||
			stored.actorRole !== context.role ||
			stored.reason !== context.reason ||
			stored.assessmentId !== (context.role === "automation" ? context.assessmentId : undefined) ||
			stored.assessmentPolicyVersion !==
				(context.role === "automation" ? context.policyVersion : undefined) ||
			stored.assessmentOutcome !== (context.role === "automation" ? context.outcome : undefined) ||
			(context.role === "automation"
				? stored.operatorAction !== undefined
				: stored.operatorAction?.action !== context.operatorAction.action ||
					stored.operatorAction.idempotencyKey !== context.operatorAction.idempotencyKey) ||
			stored.label.src !== this.signer.issuerDid ||
			stored.label.uri !== proposal.subject.uri ||
			stored.label.cid !== cid ||
			stored.label.val !== proposal.value ||
			(stored.label.neg === true) !== (proposal.negate === true) ||
			stored.label.exp !== proposal.expiresAt
		) {
			throw new TypeError("idempotency key is already bound to a different issuance");
		}
	}

	private async publishBestEffort(issued: IssuedListingLabel): Promise<IssuedListingLabel> {
		if (!this.publicationTarget) return issued;
		try {
			await this.publicationTarget.notify(issued.sequence);
			return (await this.readByIdempotencyKey(issued.idempotencyKey)) ?? issued;
		} catch (error) {
			this.onPublicationError?.(error, issued);
			return issued;
		}
	}
}

function assertBoundedFinalizationJson(summaryJson: string, coverageJson: string): void {
	const encoder = new TextEncoder();
	if (encoder.encode(summaryJson).byteLength > 64 * 1024) {
		throw new RangeError("assessment finalization summary exceeds its storage limit");
	}
	if (encoder.encode(coverageJson).byteLength > 16 * 1024) {
		throw new RangeError("assessment finalization coverage exceeds its storage limit");
	}
}
