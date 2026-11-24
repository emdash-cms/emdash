/**
 * The shared document's layout. Each `portableText` field is the XML fragment `field:{slug}`.
 * Every other field with a column, including a reference without a relation, is a plain JSON
 * value in the `fields` map under its slug, and the entry slug is under `slug` in the same map.
 * Clients depend on this layout.
 */

import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { findUnsupportedPortableTextMarks } from "../lib/portable-text-marks.js";
import {
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "../portable-text/convert.js";
import { portableTextSchema } from "../portable-text/schema.js";

/** A field as the layout needs it. Only the `portableText` type changes how it is stored. */
export interface LayoutField {
	slug: string;
	type: string;
}

/** The entry slug. No field can take its key, because `slug` is a reserved field slug. */
export const ENTRY_SLUG = { slug: "slug", type: "slug" } as const satisfies LayoutField;

export const FIELDS_MAP = "fields";
export const FRAGMENT_PREFIX = "field:";

type Schema = ReturnType<typeof portableTextSchema>;
type EditorNode = ReturnType<Schema["nodeFromJSON"]>;
type SharedType = Y.Doc["share"] extends Map<string, infer T> ? T : never;

let schema: Schema | undefined;

/** `portableTextSchema()` builds the schema again on every call. */
export function editorSchema(): Schema {
	schema ??= portableTextSchema();
	return schema;
}

/**
 * A field's value in the document. Rich text is read without a schema, which can't change the
 * document, and converted with the shared converter, which throws for content it can't convert.
 * An absent value reads as null, so a save that sends it clears the stored value. Values are
 * copies, so a caller that changes one never changes the document; a shared type a client
 * nested can't be copied and throws.
 */
export function readField(doc: Y.Doc, field: LayoutField): unknown {
	if (field.type === "portableText") {
		const { content } = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(fragmentName(field.slug)));
		// Text at the fragment's top level comes back as an array of text nodes.
		return prosemirrorToPortableText({ type: "doc", content: content.flat() });
	}
	return structuredClone(doc.getMap(FIELDS_MAP).get(field.slug) ?? null);
}

export function readSlug(doc: Y.Doc): string | null {
	const slug = readField(doc, ENTRY_SLUG);
	return typeof slug === "string" ? slug : null;
}

/** Each field's value in the document, keyed by slug. */
export function readFields(doc: Y.Doc, fields: readonly LayoutField[]): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const field of fields) values[field.slug] = readField(doc, field);
	return values;
}

/**
 * Writes a value into the document in one transaction with `origin`. Rich text goes through
 * `updateYFragment`, which keeps the unchanged blocks at both ends, so concurrent edits to them
 * survive. Returns false, writing nothing, for rich text the editor can't represent.
 */
export function writeField(
	doc: Y.Doc,
	field: LayoutField,
	value: unknown,
	pluginTypes: readonly string[],
	origin: unknown,
): boolean {
	const write = fieldWrite(field, value, pluginTypes);
	if (!write) return false;
	doc.transact(() => write(doc), origin);
	return true;
}

/**
 * What `writeField` writes, with rich text converted once, to run inside a caller's
 * transaction. Null for rich text the editor can't represent.
 */
export function fieldWrite(
	field: LayoutField,
	value: unknown,
	pluginTypes: readonly string[],
): ((doc: Y.Doc) => void) | null {
	if (field.type !== "portableText") {
		return (doc) => {
			const map = doc.getMap(FIELDS_MAP);
			if (value === undefined) map.delete(field.slug);
			else map.set(field.slug, value);
		};
	}
	const node = editorNode(value, new Set(pluginTypes));
	if (!node) return null;
	return (doc) => {
		updateYFragment(doc, doc.getXmlFragment(fragmentName(field.slug)), node, {
			mapping: new Map(),
			isOMark: new Map(),
		});
	};
}

/**
 * The fields (and `slug`) a transaction changed. Each changed type is followed up to its root:
 * `changedParentTypes` misses changes made directly to a root that hasn't been typed yet, as in
 * a document loaded from stored updates.
 */
export function touchedFields(transaction: Y.Transaction): Set<string> {
	const roots = new Map<SharedType, string>();
	for (const [name, type] of transaction.doc.share) roots.set(type, name);
	const touched = new Set<string>();
	for (const [type, keys] of transaction.changed) {
		let root: SharedType = type;
		let child: Y.Item | null = null;
		while (root._item) {
			const parent = root._item.parent;
			if (!(parent instanceof Y.AbstractType)) break;
			child = root._item;
			root = parent;
		}
		const name = roots.get(root);
		if (name === FIELDS_MAP) {
			if (!child) {
				for (const key of keys) if (key !== null) touched.add(key);
			} else if (child.parentSub !== null) {
				touched.add(child.parentSub);
			}
		} else if (name?.startsWith(FRAGMENT_PREFIX)) {
			touched.add(name.slice(FRAGMENT_PREFIX.length));
		}
	}
	return touched;
}

export function fragmentName(slug: string): string {
	return `${FRAGMENT_PREFIX}${slug}`;
}

function editorNode(value: unknown, pluginTypes: ReadonlySet<string>): EditorNode | null {
	if (value != null && !Array.isArray(value)) return null;
	const blocks: PortableTextBlock[] = value ?? [];
	if (findUnsupportedPortableTextMarks(blocks).length > 0) return null;
	try {
		return editorSchema().nodeFromJSON(portableTextToProsemirror(blocks, pluginTypes));
	} catch {
		return null;
	}
}
