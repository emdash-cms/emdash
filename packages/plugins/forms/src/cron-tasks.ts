/**
 * Cron task names for the forms plugin.
 *
 * The separator must stay within the cron task-name alphabet
 * (letters, digits, underscores, hyphens) — colons are rejected.
 */
export const DIGEST_TASK_PREFIX = "digest_";

export function digestTaskName(formId: string): string {
	return `${DIGEST_TASK_PREFIX}${formId}`;
}

export function parseDigestFormId(taskName: string): string | null {
	if (!taskName.startsWith(DIGEST_TASK_PREFIX)) return null;
	return taskName.slice(DIGEST_TASK_PREFIX.length);
}
