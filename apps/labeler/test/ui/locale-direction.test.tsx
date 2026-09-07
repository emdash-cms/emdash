import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleDirectionProvider } from "../../src/admin/LocaleDirectionProvider.js";

afterEach(() => {
	cleanup();
	document.documentElement.lang = "en";
	document.documentElement.dir = "ltr";
});

describe("labeler admin locale direction", () => {
	it("syncs an RTL locale to the document and Kumo provider", async () => {
		render(<LocaleDirectionProvider locale="ar">مرحبا</LocaleDirectionProvider>);

		await waitFor(() => {
			expect(document.documentElement.lang).toBe("ar");
			expect(document.documentElement.dir).toBe("rtl");
		});
	});
});
