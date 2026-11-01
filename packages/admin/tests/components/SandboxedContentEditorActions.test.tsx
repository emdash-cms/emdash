import { Toasty } from "@cloudflare/kumo";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { describe, expect, it, vi } from "vitest";

import { SandboxedContentEditorActions } from "../../src/components/SandboxedContentEditorActions.js";
import type { ResolvedSandboxedEditorAction } from "../../src/lib/sandboxed-editor-extensions.js";
import { messages as enMessages } from "../../src/locales/en/messages.mjs";
import { render } from "../utils/render.js";

function action(label: string): ResolvedSandboxedEditorAction {
	return {
		pluginId: "insights",
		extension: {
			id: "inspect",
			label,
			route: "/inspect",
			placement: "toolbar",
		},
	};
}

describe("SandboxedContentEditorActions", () => {
	it("renders an untranslated label without invoking Lingui's compiler", async () => {
		const localI18n = setupI18n({ locale: "en", messages: { en: enMessages } });
		localI18n.setMessagesCompiler(undefined as never);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const screen = await render(
				<SandboxedContentEditorActions
					actions={[action("Inspect saved entry")]}
					collection="posts"
					entryId="entry-1"
				/>,
				{
					wrapper: ({ children }) => (
						<I18nProvider i18n={localI18n}>
							<Toasty>{children}</Toasty>
						</I18nProvider>
					),
				},
			);

			await expect
				.element(screen.getByRole("button", { name: "Inspect saved entry" }))
				.toBeVisible();
			expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Inspect saved entry"));
		} finally {
			warn.mockRestore();
		}
	});

	it("translates an action label found in the active catalog", async () => {
		const localI18n = setupI18n({
			locale: "en",
			messages: { en: { ...enMessages, "Inspect saved entry": ["Gespeicherten Eintrag prüfen"] } },
		});
		localI18n.setMessagesCompiler(undefined as never);
		const screen = await render(
			<SandboxedContentEditorActions
				actions={[action("Inspect saved entry")]}
				collection="posts"
				entryId="entry-1"
			/>,
			{
				wrapper: ({ children }) => (
					<I18nProvider i18n={localI18n}>
						<Toasty>{children}</Toasty>
					</I18nProvider>
				),
			},
		);

		await expect
			.element(screen.getByRole("button", { name: "Gespeicherten Eintrag prüfen" }))
			.toBeVisible();
	});
});
