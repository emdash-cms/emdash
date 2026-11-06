import { createAggregatorReconciliationClient } from "./aggregator-reconciliation.js";
import app from "./app.js";
import { createD1AssessmentLifecycleStore } from "./assessment/lifecycle.js";
import { purgeExpiredMediaQuarantine } from "./assessment/runtime-media.js";
import { createProductionListingLabelIssuer } from "./assessment/runtime.js";
import { processDiscoveryQueue, quarantineDiscoveryDeadLetters } from "./discovery/queue.js";
import { logEvent } from "./observability.js";
import {
	createD1AuthoritativeCursorStore,
	reconcileAuthoritativeRegistry,
} from "./reconciliation/authoritative.js";
import { createD1LabelerReconciliationStore, reconcileLabeler } from "./reconciliation/index.js";
import { repairLabelerReconciliationFindings } from "./reconciliation/repair.js";
import { createReconciliationWorkflowControl } from "./reconciliation/workflows.js";
import { readAssessmentVersions } from "./runtime-config.js";
import { createLabelPublicationTarget, publishPendingLabels } from "./subscriptions/index.js";

export { AssessmentWorkflow } from "./assessment/workflow.js";
export { LiveEvaluationWorkflow } from "../evals/workflow.js";
export { LabelerDiscoveryDO } from "./discovery-do.js";
export { LabelSubscriptionDO } from "./label-subscription-do.js";

const DISCOVERY_DO_NAME = "main";

export default {
	async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, context);
	},

	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		logEvent("info", "reconciliation_tick", {
			cron: controller.cron,
			scheduledTime: controller.scheduledTime,
		});
		const discovery = env.LABELER_DISCOVERY_DO.getByName(DISCOVERY_DO_NAME);
		const publicationTarget = createLabelPublicationTarget(env.LABEL_SUBSCRIPTION_DO);
		const authoritativeClient = createAggregatorReconciliationClient(
			env.AGGREGATOR_RECONCILIATION,
			env.RECONCILIATION_TOKEN,
		);
		const workflowControl = createReconciliationWorkflowControl(env.ASSESSMENT_WORKFLOW);
		const [, publication, reconciliation, authoritative, mediaPurge] = await Promise.all([
			discovery.wake(controller.scheduledTime),
			publishPendingLabels(env.DB, publicationTarget),
			reconcileLabeler({
				store: createD1LabelerReconciliationStore(env.DB),
				lifecycle: createD1AssessmentLifecycleStore(env.DB),
				workflow: env.ASSESSMENT_WORKFLOW,
				...workflowControl,
				versions: readAssessmentVersions(env),
				expectedLabelSource: env.LABELER_DID,
			}),
			reconcileAuthoritativeRegistry({
				client: authoritativeClient,
				cursor: createD1AuthoritativeCursorStore(env.DB),
				lifecycle: createD1AssessmentLifecycleStore(env.DB),
				workflow: env.ASSESSMENT_WORKFLOW,
				...workflowControl,
				versions: readAssessmentVersions(env),
			}),
			purgeExpiredMediaQuarantine(env.DB, env.MEDIA_QUARANTINE),
		]);
		const repair = await repairLabelerReconciliationFindings({
			db: env.DB,
			report: reconciliation,
			lifecycle: createD1AssessmentLifecycleStore(env.DB),
			workflow: env.ASSESSMENT_WORKFLOW,
			...workflowControl,
			queue: env.DISCOVERY_QUEUE,
			authoritative: authoritativeClient,
			versions: readAssessmentVersions(env),
		});
		let recoveredOutcomeLabels = 0;
		if (reconciliation.missingOutcomeLabels.length > 0) {
			const issuer = await createProductionListingLabelIssuer(env);
			for (const missing of reconciliation.missingOutcomeLabels) {
				await issuer.issue(
					{
						actorDid: env.LABELER_DID,
						role: "automation",
						assessmentId: missing.assessmentId,
						policyVersion: missing.policyVersion,
						outcome: missing.outcome,
						reason: "Recovered a missing signed assessment outcome.",
						idempotencyKey: `recovery:${missing.assessmentId}:${missing.outcome}`,
					},
					{ subject: missing.subject, value: missing.expectedLabel },
				);
				recoveredOutcomeLabels += 1;
			}
		}
		logEvent("info", "label_publication_backstop", { ...publication });
		logEvent("info", "labeler_reconciliation", {
			repairCandidates: reconciliation.repairCandidates.length,
			dispatchedRuns: reconciliation.dispatchedRunKeys.length,
			missingOutcomeLabels: reconciliation.missingOutcomeLabels.length,
			staleRuns: reconciliation.staleRuns.length,
			quarantinedItems: reconciliation.quarantinedItems.length,
		});
		logEvent("info", "authoritative_registry_reconciliation", authoritative);
		logEvent("info", "labeler_reconciliation_repair", {
			...repair,
			recoveredOutcomeLabels,
		});
		logEvent("info", "media_quarantine_purge", mediaPurge);
	},

	async queue(batch: MessageBatch, env: Env) {
		if (batch.queue === "emdash-labeler-discovery-dlq") {
			await quarantineDiscoveryDeadLetters(batch, env);
			return;
		}
		await processDiscoveryQueue(batch, env);
	},
} satisfies ExportedHandler<Env>;
