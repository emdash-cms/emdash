/**
 * Error messages for the Forms admin pages.
 *
 * Kept free of React and Kumo imports so the status handling can be unit tested.
 * A 403 is a permission problem: it must never be shown as an empty list or a
 * generic failure, and it must never be swallowed silently.
 *
 * Messages are Lingui descriptors resolved with the admin's i18n instance in the
 * component. Plugin source is not run through the Lingui macro, so the IDs are
 * the ones Lingui generates for each message; the `i18n` comments mark them for
 * extraction.
 */

/** A Lingui message descriptor with a generated ID. */
export interface AdminMessage {
	id: string;
	message: string;
	values?: Record<string, unknown>;
}

export const FORMS_LOAD_FAILED: AdminMessage = /*i18n*/ {
	id: "GVwd6E",
	message: "Failed to load forms",
};
export const SUBMISSIONS_LOAD_FAILED: AdminMessage = /*i18n*/ {
	id: "j7jSRd",
	message: "Failed to load submissions",
};

const FORMS_FORBIDDEN: AdminMessage = /*i18n*/ {
	id: "cqX2tz",
	message: "You don't have permission to view forms.",
};
const SUBMISSIONS_FORBIDDEN: AdminMessage = /*i18n*/ {
	id: "8y3p4b",
	message: "You don't have permission to view submissions.",
};
const WRITE_FORBIDDEN: AdminMessage = /*i18n*/ {
	id: "6LpjKb",
	message: "You don't have permission to do this.",
};

const FORBIDDEN = 403;

/** Message for a failed forms/list request. */
export function formsLoadError(res: { status: number }): AdminMessage {
	return res.status === FORBIDDEN ? FORMS_FORBIDDEN : FORMS_LOAD_FAILED;
}

/** Message for a failed submissions/list request. */
export function submissionsLoadError(res: { status: number }): AdminMessage {
	return res.status === FORBIDDEN ? SUBMISSIONS_FORBIDDEN : SUBMISSIONS_LOAD_FAILED;
}

/**
 * Message for a failed write (update, duplicate, delete, export).
 * Editors can read forms but the write routes require plugins:manage.
 */
export function writeError(res: { status: number }, fallback: AdminMessage): AdminMessage {
	return res.status === FORBIDDEN ? WRITE_FORBIDDEN : fallback;
}
