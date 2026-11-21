import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { AdminDocumentTitle, useAdminPageTitle } from "../src/components/AdminDocumentTitle.js";
import { render } from "./utils/render.tsx";
import { waitFor } from "./utils/test-helpers.js";

function Editor({ title }: { title: string }) {
	useAdminPageTitle(title);
	return null;
}

function Screen({
	siteName,
	pageKey = "/",
	pageTitle = "Dashboard",
	editorTitle,
}: {
	siteName?: string;
	pageKey?: string;
	pageTitle?: string;
	editorTitle?: string;
}) {
	return (
		<I18nProvider i18n={i18n}>
			<AdminDocumentTitle siteName={siteName} pageKey={pageKey} pageTitle={pageTitle}>
				{editorTitle && <Editor title={editorTitle} />}
			</AdminDocumentTitle>
		</I18nProvider>
	);
}

describe("admin browser tab titles", () => {
	it("reacts to navigation and site name changes, with a blank-site fallback", async () => {
		const view = await render(<Screen />);
		await waitFor(() => expect(document.title).toBe("Dashboard · EmDash"));
		await view.rerender(<Screen siteName="My Site" pageKey="/settings" pageTitle="Settings" />);
		await waitFor(() => expect(document.title).toBe("Settings · My Site"));
		await view.rerender(<Screen siteName="  " pageKey="/settings" pageTitle="Settings" />);
		await waitFor(() => expect(document.title).toBe("Settings · EmDash"));
	});

	it("updates editor titles and clears them on navigation", async () => {
		const view = await render(
			<Screen
				siteName="My Site"
				pageKey="/content/products/1"
				pageTitle="Products"
				editorTitle="Edit Product: Blue mug"
			/>,
		);
		await waitFor(() => expect(document.title).toBe("Edit Product: Blue mug · My Site"));
		await view.rerender(
			<Screen
				siteName="My Site"
				pageKey="/content/products/1"
				pageTitle="Products"
				editorTitle="Edit Product: Red mug"
			/>,
		);
		await waitFor(() => expect(document.title).toBe("Edit Product: Red mug · My Site"));
		await view.rerender(<Screen siteName="My Site" pageKey="/media" pageTitle="Media" />);
		await waitFor(() => expect(document.title).toBe("Media · My Site"));
	});
});
