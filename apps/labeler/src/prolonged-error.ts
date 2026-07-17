/**
 * The reconciliation cron's prolonged-error escalation pass (plan W10.5
 * follow-up). For each terminal `error` assessment that has stayed the live,
 * unsuperseded run past the thresholds, it walks the two-stage ladder:
 *
 *   - 24h: raise a `assessment-prolonged-error` operational_event (severity
 *     high, no operator action) so operators can triage an infra-vs-publisher
 *     cause. The event insert and the `operator_alerted_at` mark commit in one
 *     `db.batch`, so a crash can never raise the alert without recording it and
 *     re-alert on the next tick.
 *   - 72h: send the publisher notice, then stamp `publisher_notified_at`. The
 *     notice's own `(issuance, id)` dedup makes a crash between send and mark
 *     self-heal — the next tick re-sends nothing and stamps the mark.
 *
 * Each stage is fire-once across the 5-minute ticks via
 * `assessment_error_escalations` (migration 0010). The pass takes {@link NotifyDeps}
 * because the 72h stage needs the sender; the cron builds it with
 * `safeCreateNotifyDeps` and skips the pass when it is unavailable.
 */

import {
	buildMarkOperatorAlerted,
	ensureEscalationRow,
	findEscalatableErrors,
	getEscalation,
	markPublisherNotified,
} from "./assessment-error-escalations.js";
import { getAssessment } from "./assessment-store.js";
import { PROLONGED_ERROR_PUBLISHER_THRESHOLD_MS } from "./constants.js";
import type { NotifyDeps } from "./notification-triggers.js";
import { notifyProlongedError } from "./notification-triggers.js";
import { buildOperationalEventInsert, newOperationalEventId } from "./operational-events.js";

export async function runProlongedErrorEscalation(deps: NotifyDeps, now: Date): Promise<void> {
	const escalatable = await findEscalatableErrors(deps.db, now);
	for (const error of escalatable) {
		await ensureEscalationRow(deps.db, {
			assessmentId: error.id,
			subjectUri: error.uri,
			subjectCid: error.cid,
			now,
		});
		const escalation = await getEscalation(deps.db, error.id);
		if (!escalation) continue;

		if (escalation.operatorAlertedAtEpochMs === null) {
			const eventInsert = buildOperationalEventInsert(deps.db, {
				id: newOperationalEventId(),
				eventType: "assessment-prolonged-error",
				severity: "high",
				actionId: null,
				subjectUri: error.uri,
				payload: { assessmentId: error.id, cid: error.cid },
				now,
				gateOnUnalertedEscalation: { assessmentId: error.id },
			});
			await deps.db.batch([eventInsert, buildMarkOperatorAlerted(deps.db, error.id, now)]);
		}

		if (
			escalation.publisherNotifiedAtEpochMs === null &&
			now.getTime() - error.completedAtEpochMs >= PROLONGED_ERROR_PUBLISHER_THRESHOLD_MS
		) {
			const assessment = await getAssessment(deps.db, error.id);
			if (!assessment) continue;
			// Only stamp the fire-once mark when the trigger reached a terminal
			// outcome. A transient failure (aggregator read / pre-claim D1 write threw
			// before any notifications row was claimed) returns false — leave the mark
			// null so the next tick retries rather than silently dropping the notice.
			const processed = await notifyProlongedError(deps, assessment);
			if (processed) await markPublisherNotified(deps.db, error.id, now);
		}
	}
}
