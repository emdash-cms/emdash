// What a blocks field's controls have to say: a problem once it shows, and while a control has
// focus its hint and count. Under its label, a control says it on the label's line. Beside its
// label, it says it at the end of its own line, and a problem with no room there goes on a line of
// its own under the control once focus has left it. Nothing moves as focus comes or goes.

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import {
	isLinkField,
	type LayoutFieldDefinition,
	splitLabelHint,
} from "../lib/block-field-layout.js";
import type { BlockValueIssue } from "../lib/block-validation.js";
import { cn } from "../lib/utils.js";
import { onFocusLeave } from "./block-field-keyboard.js";
import { NOTE, NOTE_ON_FOCUS } from "./block-field-styles.js";

/**
 * Field types whose empty control shows a placeholder, so with no label line, a required one says
 * "Required" itself.
 */
const EMPTY_SHOWN_BY_CONTROL = new Set([
	"string",
	"text",
	"url",
	"number",
	"integer",
	"select",
	"datetime",
	"image",
	"file",
]);

interface IssueContext {
	/** The field's hint, which a broken format restates after naming the problem. */
	hint?: string;
	/** The field holds a link. */
	link?: boolean;
	/** For a line with little room: the problem without the hint. */
	brief?: boolean;
}

export function useIssueMessage() {
	const { t, i18n } = useLingui();
	return React.useCallback(
		(issue: BlockValueIssue, { hint, link = false, brief = false }: IssueContext = {}): string => {
			switch (issue.code) {
				case "required":
					return t`Required`;
				case "invalid_format": {
					const isLink = link || issue.format === "url";
					if (hint && !brief)
						return isLink ? t`Invalid link. ${hint}` : t`Check the format. ${hint}`;
					if (issue.format === "url" && !brief)
						return t`Enter a valid URL (e.g. https://example.com)`;
					return isLink ? t`Invalid link` : t`Check the format`;
				}
				case "invalid_value":
					return t`Choose one of the options`;
				case "not_integer":
					return t`Enter a whole number`;
				case "too_small": {
					const minimum = issue.minimum ?? 0;
					if (issue.origin === "array") {
						return plural(minimum, { one: "Add at least # item", other: "Add at least # items" });
					}
					if (issue.origin === "string") {
						return plural(minimum, {
							one: "Use at least # character",
							other: "Use at least # characters",
						});
					}
					const formatted = i18n.number(minimum);
					return t`Enter ${formatted} or more`;
				}
				case "too_big": {
					const maximum = issue.maximum ?? 0;
					if (issue.origin === "array") {
						return plural(maximum, { one: "Keep to # item", other: "Keep to # items" });
					}
					if (issue.origin === "string") {
						return plural(maximum, {
							one: "Use at most # character",
							other: "Use at most # characters",
						});
					}
					const formatted = i18n.number(maximum);
					return t`Enter ${formatted} or less`;
				}
			}
		},
		[t, i18n],
	);
}

export function isEmptyValue(value: unknown): boolean {
	return value === undefined || value === null || value === "";
}

/** Which of a label line's controls a note belongs to: its only one, or a half of a button row. */
export type NoteSource = "field" | "text" | "link";

/** What a control has to say, and how its empty value reads. */
interface ControlNotes {
	/** Its problem, once that shows, when the control can't say it itself. */
	message?: string;
	/** The problem in a few words, for the end of the control's own line. */
	briefMessage?: string;
	/** Shown while it has focus, unless a problem shows. */
	hint?: string;
	/** Where its character count or range shows while it has focus. */
	countSlotId?: string;
	/** Whether it counts its characters or states its range. */
	counted: boolean;
	placeholder: string;
	/** The placeholder names the control or says it's required, so it's read like any text. */
	placeholderSays: boolean;
	/** Its empty placeholder says its problem, so it turns red. */
	emptyIssue: boolean;
}

export type NotedControl = ControlNotes & { source: NoteSource };

function countsItself(field: LayoutFieldDefinition): boolean {
	const keys =
		field.type === "number" || field.type === "integer"
			? ["min", "max"]
			: field.type === "string" || field.type === "text"
				? ["minLength", "maxLength"]
				: [];
	return keys.some((key) => {
		const bound = field.validation?.[key];
		return typeof bound === "number" && Number.isFinite(bound);
	});
}

export function useControlNotes() {
	const { t } = useLingui();
	const issueMessage = useIssueMessage();
	return (input: {
		field: LayoutFieldDefinition;
		/** The control's id. */
		id: string;
		value: unknown;
		issue?: BlockValueIssue;
		placeholder?: string;
		emptyPlaceholder?: string;
		/** A label's line says what the control has to say. */
		onLabelLine: boolean;
		cell?: boolean;
	}): ControlNotes => {
		const { field, issue, placeholder: override, onLabelLine, cell = false } = input;
		const { hint } = splitLabelHint(field.label);
		const empty = isEmptyValue(input.value);
		const about = { hint, link: isLinkField(field) };
		const message = issue ? issueMessage(issue, about) : undefined;
		const emptyIssue =
			!onLabelLine &&
			issue?.code === "required" &&
			override === undefined &&
			empty &&
			EMPTY_SHOWN_BY_CONTROL.has(field.type);
		// Once the label's line says Required, the empty control reads like any other empty one.
		const saysRequired = Boolean(field.required) && !(onLabelLine && message);
		const placeholder =
			override ?? (saysRequired ? t`Required` : (hint ?? input.emptyPlaceholder ?? t`Empty`));
		return {
			message: emptyIssue ? undefined : message,
			briefMessage:
				issue && !emptyIssue ? issueMessage(issue, { ...about, brief: true }) : undefined,
			hint: !cell && hint && !(placeholder === hint && empty) ? hint : undefined,
			countSlotId: cell ? undefined : `${input.id}-count`,
			counted: !cell && countsItself(field),
			placeholder,
			placeholderSays: override !== undefined || saysRequired,
			emptyIssue,
		};
	};
}

/** Tracks which of a field's controls has focus, by its `data-note`, ignoring focus in its popups. */
function useNoteFocus() {
	const [focused, setFocused] = React.useState<NoteSource | null>(null);
	const props = {
		onFocus: (event: React.FocusEvent<HTMLElement>) => {
			if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
			const source = event.target.closest("[data-note]")?.getAttribute("data-note");
			setFocused(source === "field" || source === "text" || source === "link" ? source : null);
		},
		onBlur: onFocusLeave(() => setFocused(null)),
	};
	return { focused, props };
}

export const NOTE_DOT = <span className="text-kumo-placeholder">·</span>;

/** From this width a settings row's label sits beside its value, whose controls say their own notes. */
const BESIDE_VALUE_HIDDEN = "@min-[440px]/blocks:hidden";

/**
 * A field's label, with what its controls have to say on the label's own line: the problem once it
 * shows, and the focused control's hint and count. A problem too long for the line wraps rather
 * than being cut short. `side` is a settings row's label, which once it sits beside its value
 * leaves the notes to the controls.
 */
function NotedLabel({
	as: Element = "label",
	id,
	htmlFor,
	className,
	text,
	controls,
	focused,
	side = false,
}: {
	as?: "label" | "span";
	id: string;
	htmlFor?: string;
	className: string;
	text: string;
	controls: readonly NotedControl[];
	focused: NoteSource | null;
	side?: boolean;
}) {
	const rest = controls.find((control) => control.message)?.message;
	const hasNotes = Boolean(rest) || controls.some((control) => control.hint || control.countSlotId);
	return (
		<Element
			id={id}
			htmlFor={Element === "label" ? htmlFor : undefined}
			className={cn(className, "flex items-baseline gap-x-1.5")}
		>
			<span className="min-w-0 wrap-anywhere">{text}</span>
			{hasNotes && (
				<span
					aria-hidden="true"
					className={cn(
						NOTE,
						"flex min-w-0 flex-1 basis-0 items-baseline gap-x-1.5 font-normal",
						side && BESIDE_VALUE_HIDDEN,
					)}
				>
					{rest && (
						<span className="flex min-w-0 items-baseline gap-x-1.5">
							{NOTE_DOT}
							<span dir="auto" className="min-w-0 wrap-anywhere text-kumo-danger">
								{rest}
							</span>
						</span>
					)}
					{controls.map((control) => {
						const shown = control.source === focused;
						const note = control.message ?? control.hint;
						return (
							<React.Fragment key={control.source}>
								{note && (
									<span
										className={cn(
											"min-w-0 items-baseline gap-x-1.5",
											// The line shows the problem already, with focus or without.
											shown && note !== rest ? cn(NOTE_ON_FOCUS, "flex") : "hidden",
										)}
									>
										{NOTE_DOT}
										<span
											dir="auto"
											className={cn(
												"min-w-0",
												// A wrapping hint moves the rows below as focus comes, so a hint wraps only on
												// the narrowest lines, which would cut off most of it.
												control.message
													? "wrap-anywhere text-kumo-danger"
													: "truncate text-kumo-subtle @max-[22rem]/blocks:wrap-anywhere @max-[22rem]/blocks:whitespace-normal",
											)}
										>
											{note}
										</span>
									</span>
								)}
								{control.countSlotId && (
									<span
										// A settings row's control has a count slot of its own, which carries the id.
										id={side ? undefined : control.countSlotId}
										data-count-slot={control.countSlotId}
										className={cn(
											"ms-auto shrink-0 text-kumo-subtle tabular-nums",
											shown ? NOTE_ON_FOCUS : "hidden",
										)}
									/>
								)}
							</React.Fragment>
						);
					})}
				</span>
			)}
		</Element>
	);
}

/**
 * A field with its label: tracks which of its controls has focus, so the label's line shows that
 * control's notes.
 */
export function NotedField({
	label,
	side = false,
	className,
	groupProps,
	children,
}: {
	label: Omit<React.ComponentProps<typeof NotedLabel>, "focused" | "side">;
	side?: boolean;
	className: string;
	groupProps?: Pick<React.HTMLAttributes<HTMLDivElement>, "role" | "aria-labelledby">;
	children: React.ReactNode;
}) {
	const { focused, props } = useNoteFocus();
	return (
		<div {...groupProps} className={className} {...props}>
			<NotedLabel {...label} focused={focused} side={side} />
			{children}
		</div>
	);
}
