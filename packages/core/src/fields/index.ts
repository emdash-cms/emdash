// Field type exports
export { text } from "./text.js";
export { textarea } from "./textarea.js";
export { number } from "./number.js";
export { integer } from "./integer.js";
export { boolean } from "./boolean.js";
export { select } from "./select.js";
export { multiSelect } from "./multiselect.js";
export { date } from "./date.js";
export { datetime } from "./datetime.js";
export { slug } from "./slug.js";
export { image } from "./image.js";
export { file } from "./file.js";
export { reference } from "./reference.js";
export { json } from "./json.js";
export { richText } from "./richtext.js";
export { portableText } from "./portable-text.js";

// Type exports
export type {
	FieldDefinition,
	FieldUIHints,
	ColumnType,
	PortableTextBlock,
	ImageValue,
	FileValue,
} from "./types.js";

// MediaValue is canonical in media/types.ts but re-exported here for convenience
export type { MediaValue } from "../media/types.js";

export type { TextOptions } from "./text.js";
export type { TextareaOptions } from "./textarea.js";
export type { NumberOptions } from "./number.js";
export type { IntegerOptions } from "./integer.js";
export type { BooleanOptions } from "./boolean.js";
export type { SelectOptions } from "./select.js";
export type { MultiSelectOptions } from "./multiselect.js";
export type { DateOptions } from "./date.js";
export type { DatetimeOptions } from "./datetime.js";
export type { SlugOptions } from "./slug.js";
export type { FileOptions } from "./file.js";
export type { JsonOptions } from "./json.js";
export type { RichTextOptions } from "./richtext.js";
