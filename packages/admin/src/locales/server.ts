import type { MessageDescriptor, Messages } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { resolveLocale } from "./config.js";
import { loadMessages } from "./loadMessages.js";

export interface VisualEditingToolbarLabels {
	publish: string;
	publishing: string;
	sessionExpired: string;
	refreshPage: string;
	publishFailed: string;
}

const TOOLBAR_MESSAGES = {
	publish: msg({ id: "visualEditing.publish", message: "Publish" }),
	publishing: msg({ id: "visualEditing.publishing", message: "Publishing…" }),
	sessionExpired: msg({
		id: "visualEditing.sessionExpired",
		message: "Editing session expired. Refresh the page to continue.",
	}),
	refreshPage: msg({ id: "visualEditing.refreshPage", message: "Refresh page" }),
	publishFailed: msg({
		id: "visualEditing.publishFailed",
		message: "Publish failed. Check your permissions and try again.",
	}),
} satisfies Record<keyof VisualEditingToolbarLabels, MessageDescriptor>;

function resolveToolbarMessage(messages: Messages, descriptor: MessageDescriptor): string {
	const translated = descriptor.id ? messages[descriptor.id] : undefined;
	return typeof translated === "string" ? translated : (descriptor.message ?? "");
}

export function translateVisualEditingToolbarLabels(
	messages: Messages,
): VisualEditingToolbarLabels {
	return {
		publish: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.publish),
		publishing: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.publishing),
		sessionExpired: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.sessionExpired),
		refreshPage: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.refreshPage),
		publishFailed: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.publishFailed),
	};
}

export async function loadVisualEditingToolbarLabels(
	request: Request,
): Promise<VisualEditingToolbarLabels> {
	const locale = resolveLocale(request);
	const messages: Messages = await loadMessages(locale);
	return translateVisualEditingToolbarLabels(messages);
}
