export type ContentPublishingState =
	| "draft"
	| "scheduled"
	| "published"
	| "published-with-changes"
	| "update-scheduled"
	| "published-scheduled";

export function getContentPublishingState({
	isLive,
	hasPendingChanges,
	scheduledAt,
}: {
	isLive: boolean;
	hasPendingChanges: boolean;
	scheduledAt?: string | null;
}): ContentPublishingState {
	if (!isLive) return scheduledAt ? "scheduled" : "draft";
	if (scheduledAt) return hasPendingChanges ? "update-scheduled" : "published-scheduled";
	return hasPendingChanges ? "published-with-changes" : "published";
}
