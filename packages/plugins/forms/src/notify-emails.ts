/**
 * The form editor's "Notification Emails" field.
 *
 * Kept free of imports so the admin bundle and the tests can both use it.
 */

const SEPARATOR = /[\s,;]+/;

/** A quick shape check for the editor. The update route's `z.email()` is the authority. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedNotifyEmails {
	/** Addresses in the order typed, without repeats. */
	emails: string[];
	/** Entries that do not look like an email address. */
	invalid: string[];
}

/** Splits what was typed into addresses. Commas, semicolons, spaces and new lines all separate. */
export function parseNotifyEmails(text: string): ParsedNotifyEmails {
	const emails: string[] = [];
	const invalid: string[] = [];
	const seen = new Set<string>();

	for (const entry of text.split(SEPARATOR)) {
		if (!entry) continue;
		const key = entry.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (EMAIL_SHAPE.test(entry)) {
			emails.push(entry);
		} else {
			invalid.push(entry);
		}
	}

	return { emails, invalid };
}

/** The stored addresses as the text the field shows. */
export function formatNotifyEmails(emails: readonly string[] | undefined): string {
	return (emails ?? []).join(", ");
}
