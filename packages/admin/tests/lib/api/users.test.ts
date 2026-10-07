import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	completeSignup,
	validateInviteToken,
	verifySignupToken,
} from "../../../src/lib/api/index.js";

describe("invite and signup token errors", () => {
	const originalFetch = globalThis.fetch;
	const previousLocale = i18n.locale;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		i18n.loadAndActivate({ locale: previousLocale, messages: {} });
	});

	it.each([
		{
			name: "validateInviteToken",
			message: msg`Invite validation failed`,
			action: () => validateInviteToken("token"),
		},
		{
			name: "verifySignupToken",
			message: msg`Token verification failed`,
			action: () => verifySignupToken("token"),
		},
		{
			name: "completeSignup",
			message: msg`Signup completion failed`,
			action: () => completeSignup("token", {}),
		},
	])(
		"$name rejects with the translated fallback alone for an HTML error page",
		async ({ message, action }) => {
			i18n.loadAndActivate({ locale: "de", messages: { [message.id]: "Translated token error" } });
			// A response received over HTTP/2 or HTTP/3 has an empty statusText.
			globalThis.fetch = vi.fn(
				async () => new Response("<html>Bad Gateway</html>", { status: 502, statusText: "" }),
			) as typeof fetch;

			await expect(action()).rejects.toThrow(/^Translated token error$/);
		},
	);
});
