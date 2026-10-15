/**
 * The cron task behind a form's daily digest.
 *
 * `ctx.cron` accepts a task name of letters, numbers, dashes and underscores that starts with a letter,
 * so the form id is joined with a dash.
 */

const PREFIX = "digest-";

/** The task name for one form's digest. */
export function digestTaskName(formId: string): string {
	return `${PREFIX}${formId}`;
}

/** The form a digest task belongs to, or null when the task is not a digest. */
export function formIdFromDigestTask(taskName: string): string | null {
	return taskName.startsWith(PREFIX) ? taskName.slice(PREFIX.length) : null;
}
