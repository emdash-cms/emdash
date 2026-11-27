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
	commentOnEntry: string;
	commentOnField: string;
	commentsOnEntryCount: string;
	commentsOnFieldCount: string;
	commentsOnEntry: string;
	commentsOnField: string;
	noOpenComments: string;
	newComment: string;
	comment: string;
	writeReply: string;
	reply: string;
	resolve: string;
	close: string;
	commentDeleted: string;
	deletedUser: string;
	unknownUser: string;
	unnamedUser: string;
	onField: string;
	onQuote: string;
	onBlock: string;
	commentsLoadFailed: string;
	commentActionFailed: string;
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
	commentOnEntry: msg({ id: "visualEditing.commentOnEntry", message: "Comment on this entry" }),
	commentOnField: msg({ id: "visualEditing.commentOnField", message: "Comment on {field}" }),
	commentsOnEntryCount: msg({
		id: "visualEditing.commentsOnEntryCount",
		message: "Comments on this entry: {count} open",
	}),
	commentsOnFieldCount: msg({
		id: "visualEditing.commentsOnFieldCount",
		message: "Comments on {field}: {count} open",
	}),
	commentsOnEntry: msg({ id: "visualEditing.commentsOnEntry", message: "Comments on this entry" }),
	commentsOnField: msg({ id: "visualEditing.commentsOnField", message: "Comments on {field}" }),
	noOpenComments: msg({ id: "visualEditing.noOpenComments", message: "No open comments" }),
	newComment: msg({ id: "visualEditing.newComment", message: "Write a comment" }),
	comment: msg({ id: "visualEditing.comment", message: "Comment" }),
	writeReply: msg({ id: "visualEditing.writeReply", message: "Write a reply" }),
	reply: msg({ id: "visualEditing.reply", message: "Reply" }),
	resolve: msg({ id: "visualEditing.resolve", message: "Resolve" }),
	close: msg({ id: "visualEditing.close", message: "Close" }),
	commentDeleted: msg({ id: "visualEditing.commentDeleted", message: "Comment deleted" }),
	deletedUser: msg({ id: "visualEditing.deletedUser", message: "Deleted user" }),
	unknownUser: msg({ id: "visualEditing.unknownUser", message: "Unknown user" }),
	unnamedUser: msg({ id: "visualEditing.unnamedUser", message: "Unnamed user" }),
	onField: msg({ id: "visualEditing.onField", message: "On {field}" }),
	onQuote: msg({ id: "visualEditing.onQuote", message: "On “{quote}”" }),
	onBlock: msg({ id: "visualEditing.onBlock", message: "On a block" }),
	commentsLoadFailed: msg({
		id: "visualEditing.commentsLoadFailed",
		message: "Couldn't load comments",
	}),
	commentActionFailed: msg({
		id: "visualEditing.commentActionFailed",
		message: "Couldn't save. Try again.",
	}),
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
		commentOnEntry: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentOnEntry),
		commentOnField: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentOnField),
		commentsOnEntryCount: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentsOnEntryCount),
		commentsOnFieldCount: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentsOnFieldCount),
		commentsOnEntry: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentsOnEntry),
		commentsOnField: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentsOnField),
		noOpenComments: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.noOpenComments),
		newComment: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.newComment),
		comment: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.comment),
		writeReply: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.writeReply),
		reply: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.reply),
		resolve: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.resolve),
		close: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.close),
		commentDeleted: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentDeleted),
		deletedUser: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.deletedUser),
		unknownUser: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.unknownUser),
		unnamedUser: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.unnamedUser),
		onField: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.onField),
		onQuote: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.onQuote),
		onBlock: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.onBlock),
		commentsLoadFailed: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentsLoadFailed),
		commentActionFailed: resolveToolbarMessage(messages, TOOLBAR_MESSAGES.commentActionFailed),
	};
}

export async function loadVisualEditingToolbarLabels(
	request: Request,
): Promise<VisualEditingToolbarLabels> {
	const locale = resolveLocale(request);
	const messages: Messages = await loadMessages(locale);
	return translateVisualEditingToolbarLabels(messages);
}
