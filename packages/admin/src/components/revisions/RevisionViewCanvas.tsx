import * as React from "react";

import { getFieldLabel } from "../../lib/field-label.js";
import type { FieldDiff, RevisionDiff } from "../../lib/revision-diff/types.js";
import type { FieldDescriptor } from "../ContentEditor";
import { OptionalLabel } from "../OptionalLabel.js";
import { type AuthorColor, revisionTargetElementId } from "./revision-format.js";
import { RevisionDocument } from "./RevisionDocument.js";
import { BooleanFieldValue, TextFieldValue, ValueFieldValue } from "./RevisionFieldValue.js";

export interface RevisionViewCanvasProps {
	diff: RevisionDiff;
	fields: Record<string, FieldDescriptor>;
	/** The field the editor shows as the document title. */
	titleField?: string;
	showChanges: boolean;
	authorColor: AuthorColor;
	/** Accessible name, such as "Version from Today, 9:12 AM". */
	label: string;
	/** The site's time zone, which the editor shows stored times in. */
	timezone: string;
}

/** Kinds whose editor control shows Kumo's "(optional)" marker when the field isn't required. */
const OPTIONAL_MARKER_KINDS = new Set(["string", "number", "datetime", "url", "json"]);

function FieldLabel({
	id,
	optional,
	children,
}: {
	id: string;
	optional: boolean;
	children: string;
}) {
	return (
		<div id={id} className="m-0 select-none text-base font-medium text-kumo-default">
			<span className="inline-flex items-center gap-1">
				{optional ? <OptionalLabel>{children}</OptionalLabel> : children}
			</span>
		</div>
	);
}

function FieldValue({
	field,
	descriptor,
	isTitle,
	marked,
	timezone,
}: {
	field: Exclude<FieldDiff, { type: "boolean" }>;
	descriptor: FieldDescriptor | undefined;
	isTitle: boolean;
	marked: boolean;
	timezone: string;
}) {
	switch (field.type) {
		case "portableText":
			return (
				<RevisionDocument
					rows={field.rows}
					variant={field.slug === "content" ? "document" : "boxed"}
					marked={marked}
				/>
			);
		case "text":
			return (
				<TextFieldValue
					field={field}
					variant={
						isTitle && field.kind === "string"
							? "title"
							: field.kind === "richText"
								? "area"
								: "line"
					}
					marked={marked}
				/>
			);
		case "value":
			return (
				<ValueFieldValue
					field={field}
					descriptor={descriptor}
					marked={marked}
					timezone={timezone}
				/>
			);
	}
}

const RevisionField = React.memo(function RevisionField({
	field,
	descriptor,
	isTitle,
	marked,
	timezone,
}: {
	field: FieldDiff;
	descriptor: FieldDescriptor | undefined;
	isTitle: boolean;
	marked: boolean;
	timezone: string;
}) {
	const labelId = React.useId();
	const label = getFieldLabel(field.slug, descriptor ?? { label: field.label });
	const targetProps =
		field.status === "unchanged"
			? {}
			: { id: revisionTargetElementId(field.targetId), tabIndex: -1 };

	if (field.type === "boolean") {
		return (
			<BooleanFieldValue field={field} label={label} marked={marked} targetProps={targetProps} />
		);
	}

	return (
		<div {...targetProps} role="group" aria-labelledby={labelId} className="grid gap-2">
			<FieldLabel
				id={labelId}
				optional={descriptor?.required === false && OPTIONAL_MARKER_KINDS.has(field.kind)}
			>
				{label}
			</FieldLabel>
			<FieldValue
				field={field}
				descriptor={descriptor}
				isTitle={isTitle}
				marked={marked}
				timezone={timezone}
			/>
		</div>
	);
});

/**
 * A saved version of an entry, drawn read-only in place of the editor's fields with the same
 * layout. With `showChanges`, what changed since the version before it is marked in the
 * author's colour.
 */
export function RevisionViewCanvas({
	diff,
	fields,
	titleField,
	showChanges,
	authorColor,
	label,
	timezone,
}: RevisionViewCanvasProps) {
	const marked = showChanges && diff.hasPrevious;
	return (
		<article
			data-emdash-revision-view=""
			data-author-color={authorColor}
			aria-label={label}
			className="space-y-6"
		>
			{diff.fields.map((field) => (
				<RevisionField
					key={field.slug}
					field={field}
					descriptor={fields[field.slug]}
					isTitle={field.slug === titleField}
					marked={field.status === "unchanged" ? false : marked}
					timezone={timezone}
				/>
			))}
		</article>
	);
}
