/**
 * Builds and reads an entry's shared document, in the layout `@emdash-cms/admin/internal/co-editing`
 * defines for the room and its clients.
 */

import {
	editorSchema,
	ENTRY_SLUG,
	FIELDS_MAP,
	FRAGMENT_PREFIX,
	fragmentName,
} from "@emdash-cms/admin/internal/co-editing";
import { portableTextToProsemirror } from "@emdash-cms/admin/internal/portable-text";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { isStoragelessField, type FieldType, type FieldValidation } from "../schema/types.js";
import type { LoadedEntry } from "./types.js";

export interface DocumentField {
	slug: string;
	type: FieldType;
	validation?: FieldValidation | null;
}

/**
 * The fields the document holds: every field with a column, then the entry slug. A reference bound
 * to a relation keeps its selection as edges instead, which saves outside the document.
 */
export function documentFields(fields: readonly DocumentField[]): DocumentField[] {
	return [...fields.filter((field) => !isStoragelessField(field)), ENTRY_SLUG];
}

/** The entry's stored value for each document field, keyed by slug. */
export function storedValues(
	entry: Pick<LoadedEntry, "data" | "fields" | "slug">,
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of documentFields(entry.fields)) {
		values[field.slug] = field === ENTRY_SLUG ? entry.slug : ownValue(entry.data, field.slug);
	}
	return values;
}

/**
 * A new document holding the entry, in the form the editor's normalizers produce. Callers check
 * `findUnsupportedPortableTextMarks` first. Throws for a rich-text value the editor can't
 * otherwise represent, such as a table the converter refuses.
 */
export function buildDocument(
	entry: Pick<LoadedEntry, "data" | "fields" | "slug" | "pluginTypes">,
): Y.Doc {
	const doc = new Y.Doc({ gc: true });
	const pluginTypes = new Set(entry.pluginTypes);
	const values = storedValues(entry);
	const map = doc.getMap(FIELDS_MAP);
	doc.transact(() => {
		for (const field of documentFields(entry.fields)) {
			const value = values[field.slug];
			if (field.type === "portableText") {
				if (value != null && !Array.isArray(value)) {
					throw new TypeError(`Rich-text field ${field.slug} doesn't hold blocks`);
				}
				prosemirrorJSONToYXmlFragment(
					editorSchema(),
					portableTextToProsemirror(value ?? [], pluginTypes),
					doc.getXmlFragment(fragmentName(field.slug)),
				);
			} else if (value !== undefined) {
				map.set(field.slug, value);
			}
		}
	});
	return doc;
}

/**
 * The fields the document holds, whatever the schema says now: each `field:*` root as rich text,
 * each key in the `fields` map as a plain value, and `slug` as the entry slug. A map key wins over
 * a root of the same name, which only a read through another schema can have created.
 */
export function layoutFields(doc: Y.Doc): DocumentField[] {
	const map = doc.getMap(FIELDS_MAP);
	const fields: DocumentField[] = [];
	for (const name of doc.share.keys()) {
		const slug = name.slice(FRAGMENT_PREFIX.length);
		if (name.startsWith(FRAGMENT_PREFIX) && !map.has(slug)) {
			fields.push({ slug, type: "portableText" });
		}
	}
	for (const slug of map.keys()) {
		fields.push(slug === ENTRY_SLUG.slug ? ENTRY_SLUG : { slug, type: "json" });
	}
	return fields;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}
