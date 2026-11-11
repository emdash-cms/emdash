/**
 * The shared document's layout. Each `portableText` field is the XML fragment `field:{slug}`.
 * Every other field except references is a plain JSON value in the `fields` map under its slug,
 * and the entry slug is under `slug` in the same map. Clients depend on this layout.
 */

import {
	findUnsupportedPortableTextMarks,
	portableTextSchema,
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import {
	prosemirrorJSONToYXmlFragment,
	updateYFragment,
	yXmlFragmentToProsemirrorJSON,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

import type { FieldType } from "../schema/types.js";
import type { LoadedEntry } from "./types.js";

export interface DocumentField {
	slug: string;
	type: FieldType;
}

/** The entry slug. No field can take its key, because `slug` is a reserved field slug. */
export const ENTRY_SLUG: DocumentField = { slug: "slug", type: "slug" };

const FIELDS_MAP = "fields";
const FRAGMENT_PREFIX = "field:";

type Schema = ReturnType<typeof portableTextSchema>;
type EditorNode = ReturnType<Schema["nodeFromJSON"]>;
type SharedType = Y.Doc["share"] extends Map<string, infer T> ? T : never;

let schema: Schema | undefined;

/** `portableTextSchema()` builds the schema again on every call. */
function editorSchema(): Schema {
	schema ??= portableTextSchema();
	return schema;
}

/** The fields the document holds: every field except references, then the entry slug. */
export function documentFields(fields: readonly DocumentField[]): DocumentField[] {
	return [...fields.filter((field) => field.type !== "reference"), ENTRY_SLUG];
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
 * A field's value in the document. Rich text is read without a schema, which can't change the
 * document, and converted with the shared converter, which throws for content it can't convert.
 * An absent value reads as null, so a save that sends it clears the stored value. Values are
 * copies, so a caller that changes one never changes the document; a shared type a client
 * nested can't be copied and throws.
 */
export function readField(doc: Y.Doc, field: DocumentField): unknown {
	if (field.type === "portableText") {
		const { content } = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(fragmentName(field.slug)));
		// Text at the fragment's top level comes back as an array of text nodes.
		return prosemirrorToPortableText({ type: "doc", content: content.flat() });
	}
	return structuredClone(doc.getMap(FIELDS_MAP).get(field.slug) ?? null);
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

export function readSlug(doc: Y.Doc): string | null {
	const slug = readField(doc, ENTRY_SLUG);
	return typeof slug === "string" ? slug : null;
}

/** Each field's value in the document, keyed by slug. */
export function readFields(doc: Y.Doc, fields: readonly DocumentField[]): Record<string, unknown> {
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
	field: DocumentField,
	value: unknown,
	pluginTypes: readonly string[],
	origin: unknown,
): boolean {
	if (field.type !== "portableText") {
		const map = doc.getMap(FIELDS_MAP);
		doc.transact(() => {
			if (value === undefined) map.delete(field.slug);
			else map.set(field.slug, value);
		}, origin);
		return true;
	}
	const node = editorNode(value, new Set(pluginTypes));
	if (!node) return false;
	const fragment = doc.getXmlFragment(fragmentName(field.slug));
	doc.transact(() => {
		updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
	}, origin);
	return true;
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

function fragmentName(slug: string): string {
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

function ownValue(record: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}
