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
	editMode: string;
	openInAdmin: string;
	hideToolbar: string;
	draft: string;
	published: string;
	unpublishedChanges: string;
	unsaved: string;
	saving: string;
	saved: string;
	saveFailed: string;
	image: string;
	noImageSelected: string;
	altText: string;
	altTextPlaceholder: string;
	replaceImage: string;
	uploadImage: string;
	removeImage: string;
	mediaLibrary: string;
	back: string;
	loading: string;
	noImagesFound: string;
	mediaLoadFailed: string;
	uploadingFile: string;
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
	editMode: msg({ id: "visualEditing.editMode", message: "Edit mode" }),
	openInAdmin: msg({ id: "visualEditing.openInAdmin", message: "Open in admin" }),
	hideToolbar: msg({ id: "visualEditing.hideToolbar", message: "Hide toolbar" }),
	draft: msg({ id: "visualEditing.draft", message: "Draft" }),
	published: msg({ id: "visualEditing.published", message: "Published" }),
	unpublishedChanges: msg({
		id: "visualEditing.unpublishedChanges",
		message: "Unpublished changes",
	}),
	unsaved: msg({ id: "visualEditing.unsaved", message: "Unsaved" }),
	saving: msg({ id: "visualEditing.saving", message: "Saving…" }),
	saved: msg({ id: "visualEditing.saved", message: "Saved" }),
	saveFailed: msg({ id: "visualEditing.saveFailed", message: "Save failed" }),
	image: msg({ id: "visualEditing.image", message: "Image" }),
	noImageSelected: msg({ id: "visualEditing.noImageSelected", message: "No image selected" }),
	altText: msg({ id: "visualEditing.altText", message: "Alt text" }),
	altTextPlaceholder: msg({
		id: "visualEditing.altTextPlaceholder",
		message: "Describe the image",
	}),
	replaceImage: msg({ id: "visualEditing.replaceImage", message: "Replace" }),
	uploadImage: msg({ id: "visualEditing.uploadImage", message: "Upload" }),
	removeImage: msg({ id: "visualEditing.removeImage", message: "Remove" }),
	mediaLibrary: msg({ id: "visualEditing.mediaLibrary", message: "Media Library" }),
	back: msg({ id: "visualEditing.back", message: "Back" }),
	loading: msg({ id: "visualEditing.loading", message: "Loading…" }),
	noImagesFound: msg({ id: "visualEditing.noImagesFound", message: "No images found" }),
	mediaLoadFailed: msg({ id: "visualEditing.mediaLoadFailed", message: "Failed to load media" }),
	uploadingFile: msg({ id: "visualEditing.uploadingFile", message: "Uploading {filename}…" }),
} satisfies Record<keyof VisualEditingToolbarLabels, MessageDescriptor>;

function resolveToolbarMessage(messages: Messages, descriptor: MessageDescriptor): string {
	const translated = descriptor.id ? messages[descriptor.id] : undefined;
	if (typeof translated === "string") return translated;
	// Simple {name} placeholders are kept for the toolbar script to fill in.
	if (
		Array.isArray(translated) &&
		translated.every((token) => typeof token === "string" || token.length === 1)
	) {
		return translated
			.map((token) => (typeof token === "string" ? token : `{${token[0]}}`))
			.join("");
	}
	return descriptor.message ?? "";
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
		editMode: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.editMode),
		openInAdmin: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.openInAdmin),
		hideToolbar: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.hideToolbar),
		draft: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.draft),
		published: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.published),
		unpublishedChanges: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.unpublishedChanges),
		unsaved: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.unsaved),
		saving: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.saving),
		saved: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.saved),
		saveFailed: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.saveFailed),
		image: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.image),
		noImageSelected: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.noImageSelected),
		altText: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.altText),
		altTextPlaceholder: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.altTextPlaceholder),
		replaceImage: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.replaceImage),
		uploadImage: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.uploadImage),
		removeImage: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.removeImage),
		mediaLibrary: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.mediaLibrary),
		back: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.back),
		loading: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.loading),
		noImagesFound: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.noImagesFound),
		mediaLoadFailed: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.mediaLoadFailed),
		uploadingFile: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.uploadingFile),
	};
}

export interface AdminShellLabels {
	title: string;
	loading: string;
}

const ADMIN_SHELL_MESSAGES = {
	title: msg({ id: "adminShell.title", message: "{siteName} Admin" }),
	defaultTitle: msg({ id: "adminShell.defaultTitle", message: "EmDash Admin" }),
	loading: msg({ id: "adminShell.loading", message: "Loading {siteName}..." }),
	defaultLoading: msg({ id: "adminShell.defaultLoading", message: "Loading EmDash..." }),
} satisfies Record<string, MessageDescriptor>;

/**
 * Labels for the admin shell that `admin.astro` renders before the React app
 * starts: the browser tab title and the loading text.
 */
export function translateAdminShellLabels(messages: Messages, siteName?: string): AdminShellLabels {
	if (!siteName) {
		return {
			title: resolveToolbarMessage(messages, ADMIN_SHELL_MESSAGES.defaultTitle),
			loading: resolveToolbarMessage(messages, ADMIN_SHELL_MESSAGES.defaultLoading),
		};
	}
	// A replacer function keeps `$` sequences in the site name literal.
	const withSiteName = (label: string) => label.replaceAll("{siteName}", () => siteName);
	return {
		title: withSiteName(resolveToolbarMessage(messages, ADMIN_SHELL_MESSAGES.title)),
		loading: withSiteName(resolveToolbarMessage(messages, ADMIN_SHELL_MESSAGES.loading)),
	};
}

export async function loadVisualEditingToolbarLabels(
	request: Request,
): Promise<VisualEditingToolbarLabels> {
	const locale = resolveLocale(request);
	const messages: Messages = await loadMessages(locale);
	return translateVisualEditingToolbarLabels(messages);
}
