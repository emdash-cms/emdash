import { useLingui } from "@lingui/react/macro";
import { isAllowedUri } from "@tiptap/extension-link";
import * as React from "react";

import type { DiffSegment, SegmentMarks, TextRun } from "../../lib/revision-diff/types.js";

/**
 * A visually hidden lead-in, such as "Added:", for screen readers. Its own `dir` keeps the
 * interface language out of the direction `dir="auto"` finds for the text around it.
 */
export function ChangePrefix({ children }: { children: string | null }) {
	return children ? (
		<span className="sr-only" dir="auto">
			{`${children} `}
		</span>
	) : null;
}

export function EmptyValue() {
	const { t } = useLingui();
	return <span className="italic text-kumo-subtle">{t`Empty`}</span>;
}

function withBreaks(text: string): React.ReactNode {
	if (!text.includes("\n")) return text;
	return text
		.split("\n")
		.flatMap((part, index) => (index === 0 ? [part] : [<br key={index} />, part]));
}

function safeHref(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const href = value.trim();
	return href && isAllowedUri(href) ? href : undefined;
}

function withMarks(text: string, marks: SegmentMarks): React.ReactNode {
	let node: React.ReactNode = withBreaks(text);
	const decorators = new Set(marks.decorators);
	if (decorators.has("code")) node = <code>{node}</code>;
	if (decorators.has("subscript")) node = <sub>{node}</sub>;
	if (decorators.has("superscript")) node = <sup>{node}</sup>;
	if (decorators.has("strike-through")) node = <s>{node}</s>;
	if (decorators.has("underline")) node = <u>{node}</u>;
	if (decorators.has("em")) node = <em>{node}</em>;
	if (decorators.has("strong")) node = <strong>{node}</strong>;
	const link = marks.annotations.find((annotation) => annotation._type === "link");
	if (link) {
		node = (
			<a
				className="text-kumo-link underline"
				href={safeHref(link.href)}
				target="_blank"
				rel="noopener noreferrer"
			>
				{node}
			</a>
		);
	}
	return node;
}

/** Text with its formatting, and no change marks. */
export function RunsText({ runs }: { runs: readonly Pick<TextRun, "text" | "marks">[] }) {
	return (
		<>
			{runs.map((run, index) => (
				<React.Fragment key={index}>{withMarks(run.text, run.marks)}</React.Fragment>
			))}
		</>
	);
}

interface SegmentGroup {
	change: DiffSegment["change"];
	hunk: number | null;
	formatChanged: boolean;
	segments: DiffSegment[];
}

function groupSegments(segments: readonly DiffSegment[]): SegmentGroup[] {
	const groups: SegmentGroup[] = [];
	for (const segment of segments) {
		const formatChanged = segment.change === "same" && segment.formatChanged;
		const last = groups.at(-1);
		if (
			last &&
			last.change === segment.change &&
			last.hunk === segment.hunk &&
			last.formatChanged === formatChanged
		) {
			last.segments.push(segment);
		} else {
			groups.push({
				change: segment.change,
				hunk: segment.hunk,
				formatChanged,
				segments: [segment],
			});
		}
	}
	return groups;
}

function Removed({ segments, label }: { segments: readonly DiffSegment[]; label: string }) {
	return (
		<del>
			<ChangePrefix>{label}</ChangePrefix>
			<RunsText runs={segments} />
		</del>
	);
}

function Added({ segments, label }: { segments: readonly DiffSegment[]; label: string }) {
	return (
		<ins>
			<ChangePrefix>{label}</ChangePrefix>
			<RunsText runs={segments} />
		</ins>
	);
}

/**
 * A text diff drawn inline: removed text struck through, added text highlighted, and a
 * replacement kept together as a pair. Unmarked, only the version's own text shows.
 */
export function DiffText({
	segments,
	marked,
}: {
	segments: readonly DiffSegment[];
	marked: boolean;
}) {
	const { t } = useLingui();
	if (!marked) {
		return <RunsText runs={segments.filter((segment) => segment.change !== "removed")} />;
	}
	const groups = groupSegments(segments);
	const added = t`Added:`;
	const removed = t`Removed:`;
	const nodes: React.ReactNode[] = [];
	let paired: SegmentGroup | undefined;
	for (const [index, group] of groups.entries()) {
		if (group === paired) continue;
		if (group.change === "removed") {
			const next = groups[index + 1];
			if (next && next.change === "added" && group.hunk !== null && next.hunk === group.hunk) {
				paired = next;
				nodes.push(
					<span key={index} data-revision-pair="">
						<Removed segments={group.segments} label={removed} />
						<Added segments={next.segments} label={added} />
					</span>,
				);
			} else {
				nodes.push(<Removed key={index} segments={group.segments} label={removed} />);
			}
		} else if (group.change === "added") {
			nodes.push(<Added key={index} segments={group.segments} label={added} />);
		} else if (group.formatChanged) {
			nodes.push(
				<span key={index} data-revision-restyled="">
					<ChangePrefix>{t`Style changed:`}</ChangePrefix>
					<RunsText runs={group.segments} />
				</span>,
			);
		} else {
			nodes.push(<RunsText key={index} runs={group.segments} />);
		}
	}
	return <>{nodes}</>;
}

/** The text a diff shows: the new text, plus the removed text while changes are marked. */
export function visibleText(segments: readonly DiffSegment[], marked: boolean): string {
	let text = "";
	for (const segment of segments) {
		if (marked || segment.change !== "removed") text += segment.text;
	}
	return text;
}
