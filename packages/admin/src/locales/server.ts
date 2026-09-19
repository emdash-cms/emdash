import { setupI18n, type I18n, type Messages } from "@lingui/core";

import { resolveLocale } from "./config.js";
import { loadMessages } from "./loadMessages.js";

export interface VisualEditingToolbarLabels {
	publish: string;
	publishing: string;
	sessionExpired: string;
	refreshPage: string;
	publishFailed: string;
}

export function translateVisualEditingToolbarLabels(i18n: I18n): VisualEditingToolbarLabels {
	return {
		publish: i18n._({ id: "visualEditing.publish", message: "Publish" }),
		publishing: i18n._({ id: "visualEditing.publishing", message: "Publishing…" }),
		sessionExpired: i18n._({
			id: "visualEditing.sessionExpired",
			message: "Editing session expired. Refresh the page to continue.",
		}),
		refreshPage: i18n._({ id: "visualEditing.refreshPage", message: "Refresh page" }),
		publishFailed: i18n._({
			id: "visualEditing.publishFailed",
			message: "Publish failed. Check your permissions and try again.",
		}),
	};
}

export async function loadVisualEditingToolbarLabels(
	request: Request,
): Promise<VisualEditingToolbarLabels> {
	const locale = resolveLocale(request);
	const messages: Messages = await loadMessages(locale);
	const i18n = setupI18n();
	i18n.load(locale, messages);
	i18n.activate(locale);
	return translateVisualEditingToolbarLabels(i18n);
}
