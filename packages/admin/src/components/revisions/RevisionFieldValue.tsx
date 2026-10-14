import { inputVariants, LayerCard, Switch, Text } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { toDatetimeLocalInputValue } from "../../lib/datetime-local.js";
import { formatFileSize, getFileIcon, getMediaObjectPosition } from "../../lib/media-utils.js";
import { isRecord } from "../../lib/revision-diff/normalize.js";
import type { ChangeStatus, FieldDiff } from "../../lib/revision-diff/types.js";
import { cn, formatDate } from "../../lib/utils.js";
import type { FieldDescriptor } from "../ContentEditor";
import { type ImageFieldValue, mediaDisplayUrl } from "../ImageFieldRenderer.js";
import { markAttributes } from "./revision-blocks.js";
import { ChangePrefix, DiffText, EmptyValue, visibleText } from "./RevisionSegments.js";

type TextFieldDiff = Extract<FieldDiff, { type: "text" }>;
type BooleanFieldDiff = Extract<FieldDiff, { type: "boolean" }>;
type ValueFieldDiff = Extract<FieldDiff, { type: "value" }>;

/** `line` and `title` match the editor's inputs, `area` its textarea, `code` the JSON editor. */
type BoxVariant = "line" | "title" | "area" | "code";

const BOX_CLASSES: Record<BoxVariant, string> = {
	line: cn(inputVariants({ size: "base" }), "block h-auto min-h-9 py-2"),
	title: cn(inputVariants({ size: "lg" }), "block h-auto min-h-10 py-2.5 text-lg!"),
	area: cn(inputVariants({ size: "base" }), "block h-auto min-h-[calc(10lh+1rem)] py-2"),
	code: cn(inputVariants({ size: "base" }), "block h-auto min-h-[calc(8lh+1rem)] py-2 font-mono"),
};

/** A read-only stand-in for an editor input, the same size and shape as the control it replaces. */
function ValueBox({
	variant = "line",
	ring = false,
	children,
}: {
	variant?: BoxVariant;
	ring?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			dir="auto"
			data-revision-ring={ring ? "box" : undefined}
			className={cn(BOX_CLASSES[variant], "whitespace-pre-wrap break-words")}
		>
			{children}
		</div>
	);
}

function useStatusLabel(status: ChangeStatus): string | null {
	const { t } = useLingui();
	switch (status) {
		case "added":
			return t`Added:`;
		case "removed":
			return t`Removed:`;
		case "changed":
			return t`Changed:`;
		default:
			return null;
	}
}

function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

export function TextFieldValue({
	field,
	variant,
	marked,
}: {
	field: TextFieldDiff;
	variant: BoxVariant;
	marked: boolean;
}) {
	const { segments, mode, textChanged } = field.text;
	const prefix = useStatusLabel(field.status);
	const rewritten = marked && textChanged && mode === "whole";
	const text = visibleText(segments, marked);
	return (
		<ValueBox variant={variant} ring={rewritten}>
			{rewritten && <ChangePrefix>{prefix}</ChangePrefix>}
			{text ? <DiffText segments={segments} marked={marked && !rewritten} /> : <EmptyValue />}
		</ValueBox>
	);
}

export function BooleanFieldValue({
	field,
	label,
	marked,
	targetProps,
}: {
	field: BooleanFieldDiff;
	label: string;
	marked: boolean;
	targetProps: React.HTMLAttributes<HTMLDivElement>;
}) {
	const { t } = useLingui();
	const changed = marked && field.before !== field.after;
	return (
		<div {...targetProps} data-revision-tint={changed ? "field" : undefined} className="w-fit">
			{changed && <ChangePrefix>{t`Changed:`}</ChangePrefix>}
			<Switch
				label={label}
				checked={field.after}
				disabled
				className="disabled:cursor-default disabled:opacity-100"
			/>
		</div>
	);
}

function selectOptions(descriptor: FieldDescriptor | undefined) {
	return Array.isArray(descriptor?.options) ? descriptor.options : [];
}

const NAIVE_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const OFFSET_PATTERN = /(?:[zZ]|[+-]\d\d:?\d\d)$/;

/** Shows what the editor's control shows: stored instants in the site's time zone, other dates as written. */
function formatDateTimeValue(value: string, locale: string, timezone: string): string {
	const wallClock = OFFSET_PATTERN.test(value) ? toDatetimeLocalInputValue(value, timezone) : value;
	const naive = NAIVE_DATETIME_PATTERN.exec(wallClock);
	if (!naive) return value;
	const [, year, month, day, hour, minute] = naive;
	// Formatted in UTC, so the browser's own time zone can't move the wall-clock time.
	const date = new Date(
		Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0)),
	);
	return formatDate(
		date,
		locale,
		hour === undefined
			? { dateStyle: "medium", timeZone: "UTC" }
			: { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" },
	);
}

function formatScalar(
	value: unknown,
	kind: string,
	descriptor: FieldDescriptor | undefined,
	locale: string,
	timezone: string,
): string | null {
	if (isEmptyValue(value)) return null;
	if (typeof value === "string") {
		if (kind === "select") {
			return selectOptions(descriptor).find((option) => option.value === value)?.label ?? value;
		}
		if (kind === "datetime") return formatDateTimeValue(value, locale, timezone);
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

/** The value as it is now, or the old and new values as a removal and an insertion. */
function ValueSwap({
	before,
	after,
	status,
	marked,
}: {
	before: string | null;
	after: string | null;
	status: ChangeStatus;
	marked: boolean;
}) {
	const { t } = useLingui();
	const removed = marked && before !== null && before !== after && status !== "added";
	const added = marked && after !== null && before !== after && status !== "removed";
	if (!removed && !added) return after === null ? <EmptyValue /> : <>{after}</>;
	const del = removed ? (
		<del>
			<ChangePrefix>{t`Removed:`}</ChangePrefix>
			{before}
		</del>
	) : null;
	const ins = added ? (
		<ins>
			<ChangePrefix>{t`Added:`}</ChangePrefix>
			{after}
		</ins>
	) : null;
	return del && ins ? (
		<span data-revision-pair="">
			{del}
			{ins}
		</span>
	) : (
		(del ?? ins)
	);
}

function ScalarFieldValue({
	field,
	descriptor,
	marked,
	timezone,
}: {
	field: ValueFieldDiff;
	descriptor: FieldDescriptor | undefined;
	marked: boolean;
	timezone: string;
}) {
	const { i18n } = useLingui();
	const before = formatScalar(field.before, field.kind, descriptor, i18n.locale, timezone);
	const after = formatScalar(field.after, field.kind, descriptor, i18n.locale, timezone);
	return (
		<ValueBox>
			<ValueSwap before={before} after={after} status={field.status} marked={marked} />
		</ValueBox>
	);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function MultiSelectFieldValue({
	field,
	descriptor,
	marked,
}: {
	field: ValueFieldDiff;
	descriptor: FieldDescriptor | undefined;
	marked: boolean;
}) {
	const { t } = useLingui();
	const after = new Set(stringList(field.after));
	const before = new Set(marked ? stringList(field.before) : []);
	const options = selectOptions(descriptor);
	const labels = new Map(options.map((option) => [option.value, option.label]));
	const values = [
		...new Set([
			...options
				.map((option) => option.value)
				.filter((value) => after.has(value) || before.has(value)),
			...after,
			...before,
		]),
	];
	if (values.length === 0) return <EmptyValue />;
	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-2">
			{values.map((value) => {
				const label = labels.get(value) ?? value;
				const isAdded = marked && after.has(value) && !before.has(value);
				const isRemoved = !after.has(value);
				return (
					<li key={value} dir="auto">
						{isRemoved ? (
							<del>
								<ChangePrefix>{t`Removed:`}</ChangePrefix>
								{label}
							</del>
						) : isAdded ? (
							<ins>
								<ChangePrefix>{t`Added:`}</ChangePrefix>
								{label}
							</ins>
						) : (
							label
						)}
					</li>
				);
			})}
		</ul>
	);
}

function imageFieldValue(value: unknown): ImageFieldValue | string | undefined {
	if (typeof value === "string") return value || undefined;
	return isRecord(value) ? (value as unknown as ImageFieldValue) : undefined;
}

function ImageValue({
	field,
	featured,
	marked,
}: {
	field: ValueFieldDiff;
	featured: boolean;
	marked: boolean;
}) {
	const { t } = useLingui();
	const prefix = useStatusLabel(field.status);
	const removed = marked && field.status === "removed";
	const value = imageFieldValue(removed ? field.before : field.after);
	const url = mediaDisplayUrl(value);
	if (!value || !url) {
		// Same footprint as the editor's empty picker, so nothing below moves between modes.
		return (
			<div
				className={cn(
					"flex items-center justify-center border-dashed border-kumo-line bg-kumo-control",
					featured ? "min-h-33 rounded-xl border-2" : "h-32 rounded-lg border",
				)}
			>
				<EmptyValue />
			</div>
		);
	}
	const record = typeof value === "object" ? value : undefined;
	const showChange = marked && prefix !== null;
	const changeAttributes = markAttributes({ ring: showChange && !removed, dim: removed });
	const objectPosition = record ? getMediaObjectPosition(record) : undefined;

	if (!featured) {
		return (
			<div className="grid gap-2">
				{showChange && <ChangePrefix>{prefix}</ChangePrefix>}
				<img
					src={url}
					alt={record?.alt ?? ""}
					className="emdash-media-transparency-grid max-h-48 min-h-20 rounded-lg border object-cover"
					style={{ objectPosition }}
					loading="lazy"
					{...changeAttributes}
				/>
			</div>
		);
	}

	const filename = record?.filename || t`Selected image`;
	const dimensions =
		typeof record?.width === "number" && typeof record.height === "number"
			? `${record.width} × ${record.height}`
			: "";
	const metadata = [dimensions, record?.mimeType].filter(Boolean).join(" · ");
	return (
		<div className="@container/featured">
			{showChange && <ChangePrefix>{prefix}</ChangePrefix>}
			<LayerCard
				className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center rounded-xl p-0 @lg/featured:grid-cols-[12rem_minmax(0,1fr)] @lg/featured:items-stretch"
				{...changeAttributes}
			>
				<div
					className="emdash-featured-image-preview m-2 overflow-hidden rounded bg-kumo-tint ring ring-kumo-line @lg/featured:self-center"
					style={{ aspectRatio: "16 / 9" }}
				>
					<img
						src={url}
						alt=""
						className="emdash-media-transparency-grid h-full w-full object-cover"
						style={{ objectPosition }}
						loading="lazy"
					/>
				</div>
				<div className="flex min-w-0 flex-col justify-center gap-1 px-2 py-2 @lg/featured:px-4 @lg/featured:py-3">
					<Text as="p" bold truncate>
						{removed ? <del>{filename}</del> : filename}
					</Text>
					{metadata && (
						<Text as="p" variant="secondary" size="xs" truncate>
							<bdi dir="ltr">{metadata}</bdi>
						</Text>
					)}
				</div>
			</LayerCard>
		</div>
	);
}

function FileValue({ field, marked }: { field: ValueFieldDiff; marked: boolean }) {
	const { t } = useLingui();
	const prefix = useStatusLabel(field.status);
	const removed = marked && field.status === "removed";
	const value = removed ? field.before : field.after;
	if (!isRecord(value)) {
		return (
			<ValueBox>
				<EmptyValue />
			</ValueBox>
		);
	}
	const filename =
		typeof value.filename === "string" && value.filename ? value.filename : t`Untitled file`;
	const mimeType = typeof value.mimeType === "string" ? value.mimeType : "";
	const size = typeof value.size === "number" ? formatFileSize(value.size) : "";
	const metadata = [mimeType, size].filter(Boolean).join(" • ");
	const showChange = marked && prefix !== null;
	return (
		<div
			className="flex items-center gap-3 rounded-lg border p-3"
			{...markAttributes({ ring: showChange && !removed, dim: removed })}
		>
			{showChange && <ChangePrefix>{prefix}</ChangePrefix>}
			<span className="text-3xl" aria-hidden="true">
				{getFileIcon(mimeType)}
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate text-base font-medium" dir="auto">
					{removed ? <del>{filename}</del> : filename}
				</p>
				{metadata && <p className="text-xs text-kumo-subtle">{metadata}</p>}
			</div>
		</div>
	);
}

function useValueSummary(): (value: unknown, kind: string) => string | null {
	const { t } = useLingui();
	return (value, kind) => {
		if (isEmptyValue(value)) return null;
		if (Array.isArray(value)) {
			const count = value.length;
			if (kind === "blocks") return plural(count, { one: "# block", other: "# blocks" });
			if (kind === "reference") return plural(count, { one: "# entry", other: "# entries" });
			return plural(count, { one: "# item", other: "# items" });
		}
		if (typeof value === "string") return value;
		if (typeof value === "number") return String(value);
		if (typeof value === "boolean") return value ? t`On` : t`Off`;
		return JSON.stringify(value);
	};
}

/** Fields the view can't mark inline: the value or a short summary, ringed when it changed. */
function SummaryFieldValue({
	field,
	marked,
	variant = "line",
}: {
	field: ValueFieldDiff;
	marked: boolean;
	variant?: BoxVariant;
}) {
	const summarize = useValueSummary();
	const prefix = useStatusLabel(field.status);
	const json = variant === "code";
	const format = (value: unknown) =>
		json && !isEmptyValue(value)
			? typeof value === "string"
				? value
				: JSON.stringify(value, null, 2)
			: summarize(value, field.kind);
	const showChange = marked && prefix !== null;
	const removed = showChange && field.status === "removed";
	const text = format(removed ? field.before : field.after);
	return (
		<ValueBox variant={variant} ring={showChange && !removed}>
			{showChange && <ChangePrefix>{prefix}</ChangePrefix>}
			{text === null ? <EmptyValue /> : removed ? <del>{text}</del> : text}
		</ValueBox>
	);
}

const SCALAR_KINDS = new Set(["number", "datetime", "select", "string", "url", "richText", "slug"]);

export function ValueFieldValue({
	field,
	descriptor,
	marked,
	timezone,
}: {
	field: ValueFieldDiff;
	descriptor: FieldDescriptor | undefined;
	marked: boolean;
	/** The site's time zone, which the editor shows stored times in. */
	timezone: string;
}) {
	const { t } = useLingui();
	if (field.kind === "unsupported") {
		return (
			<p className="text-xs leading-4 text-kumo-subtle">
				{t`This field cannot be edited by this version of EmDash.`}
			</p>
		);
	}
	if (descriptor?.widget) return <SummaryFieldValue field={field} marked={marked} />;
	switch (field.kind) {
		case "multiSelect":
			return <MultiSelectFieldValue field={field} descriptor={descriptor} marked={marked} />;
		case "image":
			return (
				<ImageValue field={field} featured={field.slug === "featured_image"} marked={marked} />
			);
		case "file":
			return <FileValue field={field} marked={marked} />;
		case "json":
			return <SummaryFieldValue field={field} marked={marked} variant="code" />;
		case "reference":
			// A revision only records a relation's entries when that save changed them.
			if (typeof descriptor?.validation?.relation === "string" && field.after === null) {
				return (
					<ValueBox>
						<span className="italic text-kumo-subtle">{t`Not recorded in this version`}</span>
					</ValueBox>
				);
			}
			if (!Array.isArray(field.after) && !Array.isArray(field.before)) {
				return (
					<ScalarFieldValue
						field={field}
						descriptor={descriptor}
						marked={marked}
						timezone={timezone}
					/>
				);
			}
			return <SummaryFieldValue field={field} marked={marked} />;
		default:
			if (SCALAR_KINDS.has(field.kind)) {
				return (
					<ScalarFieldValue
						field={field}
						descriptor={descriptor}
						marked={marked}
						timezone={timezone}
					/>
				);
			}
			return <SummaryFieldValue field={field} marked={marked} />;
	}
}
