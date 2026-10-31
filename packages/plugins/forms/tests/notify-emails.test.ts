import { describe, expect, it } from "vitest";

import { formatNotifyEmails, parseNotifyEmails } from "../src/notify-emails.js";
import { formUpdateSchema } from "../src/schemas.js";

describe("parseNotifyEmails", () => {
	it("returns no addresses for an empty field", () => {
		expect(parseNotifyEmails("")).toEqual({ emails: [], invalid: [] });
		expect(parseNotifyEmails("  ,\n ")).toEqual({ emails: [], invalid: [] });
	});

	it("splits on commas, semicolons, spaces and new lines", () => {
		expect(
			parseNotifyEmails("a@example.com, b@example.com;c@example.com\nd@example.com").emails,
		).toEqual(["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
	});

	it("keeps one copy of a repeated address, whatever its case", () => {
		expect(parseNotifyEmails("a@example.com, A@Example.com, a@example.com").emails).toEqual([
			"a@example.com",
		]);
	});

	it("reports entries that are not addresses and leaves them out", () => {
		expect(parseNotifyEmails("a@example.com, editor, b@example")).toEqual({
			emails: ["a@example.com"],
			invalid: ["editor", "b@example"],
		});
	});

	it("produces a list the update route accepts", () => {
		const { emails } = parseNotifyEmails("a@example.com, b@example.co.uk");
		const parsed = formUpdateSchema.parse({
			id: "01JBQ8Z0000000000000000000",
			settings: { notifyEmails: emails },
		});
		expect(parsed.settings?.notifyEmails).toEqual(emails);
	});
});

describe("formatNotifyEmails", () => {
	it("round-trips through the parser", () => {
		const emails = ["a@example.com", "b@example.com"];
		expect(parseNotifyEmails(formatNotifyEmails(emails)).emails).toEqual(emails);
	});

	it("shows an empty field when nothing is stored", () => {
		expect(formatNotifyEmails(undefined)).toBe("");
		expect(formatNotifyEmails([])).toBe("");
	});
});
