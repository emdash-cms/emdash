import { format } from "date-fns";

const DATE_FORMAT_EXAMPLE_DATE = new Date(2026, 0, 23, 12);

export const DEFAULT_DATE_FORMAT = "MMMM d, yyyy";

export function formatDateFormatExample(dateFormat: string): string | null {
	try {
		return format(DATE_FORMAT_EXAMPLE_DATE, dateFormat || DEFAULT_DATE_FORMAT);
	} catch {
		return null;
	}
}
