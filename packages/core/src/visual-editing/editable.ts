/**
 * Visual editing annotation system
 *
 * Creates Proxy objects that emit data-emdash-ref attributes when spread onto elements.
 */

export interface CMSAnnotation {
	collection: string;
	id: string;
	field?: string;
	/** Entry status — only present on entry-level annotations (not field-level) */
	status?: string;
	/** Whether the entry has unpublished draft changes */
	hasDraft?: boolean;
}

/** The shape returned when spreading an edit annotation onto an element */
export interface FieldAnnotation {
	"data-emdash-ref": string;
}

export interface EditableOptions {
	/** Entry status: "draft", "published", "scheduled" */
	status?: string;
	/** true when draftRevisionId exists and differs from liveRevisionId */
	hasDraft?: boolean;
}

/**
 * Create an editable proxy for an entry.
 *
 * Usage:
 * - `{...entry.edit}` - entry-level annotation (includes status/hasDraft)
 * - `{...entry.edit.title}` - field-level annotation
 * - `{...entry.edit['nested.field']}` - nested field (bracket notation)
 */
export function createEditable(
	collection: string,
	id: string,
	options?: EditableOptions,
): EditProxy {
	const base: CMSAnnotation = {
		collection,
		id,
		...(options?.status && { status: options.status }),
		...(options?.hasDraft && { hasDraft: true }),
	};

	return new Proxy(
		{},
		{
			get(_, prop) {
				if (prop === "toJSON") return () => ({ "data-emdash-ref": JSON.stringify(base) });
				if (typeof prop === "symbol") return undefined;

				// data-emdash-ref access returns the entry-level string
				if (prop === "data-emdash-ref") return JSON.stringify(base);

				// Field-level: return a FieldAnnotation for the specific field
				return {
					"data-emdash-ref": JSON.stringify({ ...base, field: String(prop) }),
				} satisfies FieldAnnotation;
			},
			ownKeys() {
				return ["data-emdash-ref"];
			},
			getOwnPropertyDescriptor(_, prop) {
				if (prop === "data-emdash-ref") {
					return {
						configurable: true,
						enumerable: true,
						value: JSON.stringify(base),
					};
				}
				return undefined;
			},
		},
	);
}

/**
 * Create a noop proxy for production mode.
 * Spreading this produces no attributes.
 */
export function createNoop(): EditProxy {
	return new Proxy(
		{},
		{
			get(_, prop) {
				if (typeof prop === "symbol") return undefined;
				// All property access returns undefined in noop mode
				return undefined;
			},
			ownKeys() {
				return [];
			},
			getOwnPropertyDescriptor() {
				return undefined;
			},
		},
	);
}

/**
 * Visual editing proxy type.
 *
 * Spread directly onto elements for entry-level annotations: `{...entry.edit}`
 * Access a field for field-level annotations: `{...entry.edit.title}`
 *
 * In production, spreading produces no attributes (noop).
 */
export type EditProxy = {
	readonly [field: string]: Partial<FieldAnnotation>;
};
