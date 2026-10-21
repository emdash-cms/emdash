import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { BlockNoun, ChangeItem, FieldRef, Snippet } from "../../lib/revision-diff/types.js";
import { isolate } from "../../lib/utils.js";

type BlockAction = Extract<ChangeItem, { kind: "block" }>["action"];
type ImageAction = Extract<ChangeItem, { kind: "image" }>["action"];

/** Only text blocks can be restyled; other blocks describe a restyle as an edit. */
type BlockLabels = Record<Exclude<BlockAction, "restyled">, MessageDescriptor> & {
	restyled?: MessageDescriptor;
};

const BLOCK_LABELS: Record<Exclude<BlockNoun, "custom">, BlockLabels> = {
	paragraph: {
		added: msg`Added a paragraph`,
		removed: msg`Removed a paragraph`,
		edited: msg`Edited a paragraph`,
		restyled: msg`Changed the style of a paragraph`,
		moved: msg`Moved a paragraph`,
	},
	heading: {
		added: msg`Added a heading`,
		removed: msg`Removed a heading`,
		edited: msg`Edited a heading`,
		restyled: msg`Changed the style of a heading`,
		moved: msg`Moved a heading`,
	},
	quote: {
		added: msg`Added a quote`,
		removed: msg`Removed a quote`,
		edited: msg`Edited a quote`,
		restyled: msg`Changed the style of a quote`,
		moved: msg`Moved a quote`,
	},
	listItem: {
		added: msg`Added a list item`,
		removed: msg`Removed a list item`,
		edited: msg`Edited a list item`,
		restyled: msg`Changed the style of a list item`,
		moved: msg`Moved a list item`,
	},
	image: {
		added: msg`Added an image`,
		removed: msg`Removed an image`,
		edited: msg`Changed an image`,
		moved: msg`Moved an image`,
	},
	code: {
		added: msg`Added a code block`,
		removed: msg`Removed a code block`,
		edited: msg`Edited a code block`,
		moved: msg`Moved a code block`,
	},
	table: {
		added: msg`Added a table`,
		removed: msg`Removed a table`,
		edited: msg`Edited a table`,
		moved: msg`Moved a table`,
	},
	gallery: {
		added: msg`Added a gallery`,
		removed: msg`Removed a gallery`,
		edited: msg`Changed a gallery`,
		moved: msg`Moved a gallery`,
	},
	video: {
		added: msg`Added a video`,
		removed: msg`Removed a video`,
		edited: msg`Changed a video`,
		moved: msg`Moved a video`,
	},
	embed: {
		added: msg`Added an embed`,
		removed: msg`Removed an embed`,
		edited: msg`Changed an embed`,
		moved: msg`Moved an embed`,
	},
	html: {
		added: msg`Added an HTML block`,
		removed: msg`Removed an HTML block`,
		edited: msg`Edited an HTML block`,
		moved: msg`Moved an HTML block`,
	},
	divider: {
		added: msg`Added a divider`,
		removed: msg`Removed a divider`,
		edited: msg`Changed a divider`,
		moved: msg`Moved a divider`,
	},
};

const IMAGE_LABELS: Record<ImageAction, MessageDescriptor> = {
	added: msg`Added an image`,
	removed: msg`Removed an image`,
	replaced: msg`Replaced an image`,
	captionEdited: msg`Edited an image caption`,
	altEdited: msg`Edited an image description`,
	changed: msg`Changed an image`,
};

export interface ChangeLabelOptions {
	/** When the version a `restored` item copies was saved, or null when that version isn't loaded. */
	restoredWhen?: (revisionId: string) => string | null;
}

function changedField(i18n: I18n, field: FieldRef): string {
	const label = isolate(field.label);
	return i18n._(msg`Changed ${label}`);
}

function textLabel(
	i18n: I18n,
	change: Extract<ChangeItem, { kind: "text" }>["change"],
	field: FieldRef,
): string {
	const label = isolate(field.label);
	switch (change) {
		case "added":
			return i18n._(msg`Added ${label}`);
		case "removed":
			return i18n._(msg`Cleared ${label}`);
		case "edited":
			return i18n._(msg`Edited ${label}`);
	}
}

function snippetLabel(i18n: I18n, action: BlockAction, value: Snippet): string {
	const snippet = isolate(value.truncated ? `${value.text}…` : value.text);
	switch (action) {
		case "added":
			return i18n._(msg`Added “${snippet}”`);
		case "removed":
			return i18n._(msg`Removed “${snippet}”`);
		case "edited":
			return i18n._(msg`Edited “${snippet}”`);
		case "restyled":
			return i18n._(msg`Changed the style of “${snippet}”`);
		case "moved":
			return i18n._(msg`Moved “${snippet}”`);
	}
}

/** One line of a version's change list, such as "Changed the title" or "Edited “Most teams…”". */
export function changeLabel(
	i18n: I18n,
	item: ChangeItem,
	options: ChangeLabelOptions = {},
): string {
	switch (item.kind) {
		case "created":
			return i18n._(msg`First version`);
		case "earliest":
			return i18n._(msg`Earliest saved version`);
		case "restored": {
			const when = options.restoredWhen?.(item.revisionId);
			if (!when) return i18n._(msg`Restored an earlier version`);
			const date = isolate(when);
			return i18n._(msg`Restored the version from ${date}`);
		}
		case "noChanges":
			return i18n._(msg`No changes`);
		case "title":
			return i18n._(msg`Changed the title`);
		case "text":
			return textLabel(i18n, item.change, item.field);
		case "toggle": {
			const label = isolate(item.field.label);
			return item.on ? i18n._(msg`Turned on ${label}`) : i18n._(msg`Turned off ${label}`);
		}
		case "field":
			return changedField(i18n, item.field);
		case "slug": {
			if (!item.after) return i18n._(msg`Removed the slug`);
			const slug = isolate(item.after);
			return i18n._(msg`Changed the slug to “${slug}”`);
		}
		case "block": {
			if (item.noun === "custom") return changedField(i18n, item.field);
			if (item.snippet) return snippetLabel(i18n, item.action, item.snippet);
			const labels = BLOCK_LABELS[item.noun];
			return i18n._(labels[item.action] ?? labels.edited);
		}
		case "image":
			return i18n._(IMAGE_LABELS[item.action]);
	}
}
