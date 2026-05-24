/**
 * Type definitions for Cloudflare event subscription messages.
 * See: https://developers.cloudflare.com/queues/event-subscriptions/events-schemas/
 */

/** Workers Builds `build.succeeded` event. */
export interface BuildSucceededEvent {
	type: "cf.workersBuilds.worker.build.succeeded";
	source: {
		type: "workersBuilds.worker";
		workerName: string;
	};
	payload: {
		buildUuid: string;
		status: "success";
		buildOutcome: "success";
		createdAt: string;
		initializingAt: string;
		runningAt: string;
		stoppedAt: string;
		buildTriggerMetadata: {
			buildTriggerSource: string;
			branch: string;
			commitHash: string;
			commitMessage: string;
			author: string;
			buildCommand: string;
			deployCommand: string;
			rootDirectory: string;
			repoName: string;
			providerAccountName: string;
			providerType: string;
		};
	};
	metadata: {
		accountId: string;
		eventSubscriptionId: string;
		eventSchemaVersion: number;
		eventTimestamp: string;
	};
}

/**
 * Other event types we may receive from the subscription but ignore.
 * Kept loose (string `type`) so we don't block on schema updates.
 */
export interface UnknownEvent {
	type: string;
	source?: unknown;
	payload?: unknown;
	metadata?: unknown;
}

export type PerfQueueMessage = BuildSucceededEvent | UnknownEvent;

/** Type guard for the only event we actually act on. */
export function isBuildSucceeded(event: PerfQueueMessage): event is BuildSucceededEvent {
	return event.type === "cf.workersBuilds.worker.build.succeeded";
}
