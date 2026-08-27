import { requireAccessVerification } from "./access.js";
import { createAggregatorReconciliationClient } from "./aggregator-reconciliation.js";
import { createD1AssessmentLifecycleStore } from "./assessment/lifecycle.js";
import { purgeExpiredMediaQuarantine } from "./assessment/runtime-media.js";
import { createProductionListingLabelIssuer } from "./assessment/runtime.js";
import { processDiscoveryQueue, quarantineDiscoveryDeadLetters } from "./discovery/queue.js";
import { queryLabels } from "./labels/index.js";
import { logEvent } from "./observability.js";
import { handleOperatorApi } from "./operator/api.js";
import { handlePublicAssessmentXrpc } from "./public-assessment.js";
import { labelerDidDocument, labelerPolicyDocument } from "./public-service.js";
import {
	createD1AuthoritativeCursorStore,
	reconcileAuthoritativeRegistry,
} from "./reconciliation/authoritative.js";
import { createD1LabelerReconciliationStore, reconcileLabeler } from "./reconciliation/index.js";
import { repairLabelerReconciliationFindings } from "./reconciliation/repair.js";
import { createReconciliationWorkflowControl } from "./reconciliation/workflows.js";
import { readAssessmentVersions } from "./runtime-config.js";
import { createRuntimeListingLabelSigner } from "./runtime-signer.js";
import {
	createLabelPublicationTarget,
	publishPendingLabels,
	subscribeLabels,
} from "./subscriptions/index.js";

export { AssessmentWorkflow } from "./assessment/workflow.js";
export { LiveEvaluationWorkflow } from "../evals/workflow.js";
export { LabelerDiscoveryDO } from "./discovery-do.js";
export { LabelSubscriptionDO } from "./label-subscription-do.js";

const HEALTH_PATH = "/health";
const OPERATOR_PREFIX = "/_admin/";
const DISCOVERY_DO_NAME = "main";
const QUERY_LABELS_PATH = "/xrpc/com.atproto.label.queryLabels";
const SUBSCRIBE_LABELS_PATH = "/xrpc/com.atproto.label.subscribeLabels";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/.well-known/did.json") return labelerDidDocument(env);
		if (url.pathname === "/.well-known/emdash-labeler-policy.json") {
			return labelerPolicyDocument(env);
		}
		if (url.pathname === QUERY_LABELS_PATH) {
			return queryLabels(env.DB, request, () => createRuntimeListingLabelSigner(env));
		}
		if (url.pathname === SUBSCRIBE_LABELS_PATH) {
			return subscribeLabels(env.LABEL_SUBSCRIPTION_DO, request);
		}
		const publicAssessment = await handlePublicAssessmentXrpc(request, env);
		if (publicAssessment) return publicAssessment;
		if (url.pathname === HEALTH_PATH) {
			if (request.method !== "GET" && request.method !== "HEAD") {
				return new Response(null, {
					status: 405,
					headers: { allow: "GET, HEAD" },
				});
			}
			const [discovery, signing] = await Promise.all([
				env.LABELER_DISCOVERY_DO.getByName(DISCOVERY_DO_NAME).status(),
				createProductionListingLabelIssuer(env).then(
					() => ({ ready: true as const }),
					() => ({ ready: false as const, reason: "signing-configuration-invalid" as const }),
				),
			]);
			const ready = discovery.ready && signing.ready;
			const status = ready ? 200 : 503;
			if (request.method === "HEAD") {
				return new Response(null, {
					status,
					headers: { "cache-control": "no-store", "content-type": "application/json" },
				});
			}
			return Response.json(
				{
					service: "emdash-labeler",
					status: ready ? "ok" : "not-ready",
					discovery,
					signing,
				},
				{ status, headers: { "cache-control": "no-store" } },
			);
		}

		if (url.pathname.startsWith("/_admin/api/")) {
			return handleOperatorApi(request, env);
		}
		if (url.pathname === "/_admin" || url.pathname.startsWith(OPERATOR_PREFIX)) {
			const verification = await requireAccessVerification(request, env);
			if (!verification.ok) return verification;
			return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
		}

		return new Response("not found", { status: 404 });
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
