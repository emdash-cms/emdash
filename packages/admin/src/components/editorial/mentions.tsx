import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEditorialMentionable,
	type EditorialEntry,
	type EditorialPerson,
} from "../../lib/api/editorial-threads.js";
import { useDebouncedValue } from "../../lib/hooks.js";
import { cn } from "../../lib/utils.js";

const MENTION_TOKEN = /<@([^<>\s]{1,64})>/g;
const SEARCH_DEBOUNCE_MS = 200;
const MENTION_TRIGGER = /(?:^|\s)@([^\s@]{0,30})$/;

export function mentionLabel(person: Pick<EditorialPerson, "id" | "name">): string {
	return person.name?.trim() || person.id;
}

/** A picked person, shown as `@Name` in `text.slice(from, to)`. */
export interface DraftMention {
	id: string;
	from: number;
	to: number;
}

/**
 * Comment text as the composer shows it: each `<@USER_ID>` token becomes
 * `@Name`, and the range each name covers is remembered so the right tokens
 * can be put back on save.
 */
export interface MentionDraft {
	text: string;
	mentions: DraftMention[];
}

export function bodyToDraft(
	body: string,
	people: EditorialPerson[],
	unknownLabel: string,
): MentionDraft {
	const byId = new Map(people.map((person) => [person.id, person]));
	const mentions: DraftMention[] = [];
	let text = "";
	let last = 0;
	for (const match of body.matchAll(MENTION_TOKEN)) {
		text += body.slice(last, match.index);
		const id = match[1]!;
		const person = byId.get(id);
		const label = `@${person ? mentionLabel(person) : unknownLabel}`;
		mentions.push({ id, from: text.length, to: text.length + label.length });
		text += label;
		last = match.index + match[0].length;
	}
	text += body.slice(last);
	return { text, mentions };
}

/** The stored body for a draft: each remembered mention range becomes its person's token. */
export function draftToBody(draft: MentionDraft): string {
	let body = "";
	let last = 0;
	for (const mention of draft.mentions.toSorted((a, b) => a.from - b.from)) {
		body += `${draft.text.slice(last, mention.from)}<@${mention.id}>`;
		last = mention.to;
	}
	body += draft.text.slice(last);
	return body.trim();
}

/**
 * Replaces `text.slice(from, to)` with `insert`. Mentions after the change
 * move with their text; a mention the change touches is no longer a mention.
 */
export function editDraft(
	draft: MentionDraft,
	from: number,
	to: number,
	insert: string,
): MentionDraft {
	const shift = insert.length - (to - from);
	const mentions = draft.mentions.flatMap((mention) => {
		if (mention.to <= from) return [mention];
		if (mention.from >= to) {
			return [{ ...mention, from: mention.from + shift, to: mention.to + shift }];
		}
		return [];
	});
	return { text: draft.text.slice(0, from) + insert + draft.text.slice(to), mentions };
}

/**
 * The draft after the textarea's text became `text`, with the caret at
 * `caret`. The caret places the edit where the text alone is ambiguous, as
 * when a letter is typed next to the same letter.
 */
export function updateDraftText(draft: MentionDraft, text: string, caret: number): MentionDraft {
	const before = draft.text;
	let suffix = 0;
	const maxSuffix = Math.min(before.length, text.length - caret);
	while (
		suffix < maxSuffix &&
		before[before.length - 1 - suffix] === text[text.length - 1 - suffix]
	) {
		suffix++;
	}
	let prefix = 0;
	const maxPrefix = Math.min(before.length, text.length) - suffix;
	while (prefix < maxPrefix && before[prefix] === text[prefix]) prefix++;
	return editDraft(draft, prefix, before.length - suffix, text.slice(prefix, text.length - suffix));
}

/** A comment body with its mention tokens shown as names. */
export function MentionText({ body, people }: { body: string; people: EditorialPerson[] }) {
	const { t } = useLingui();
	const byId = new Map(people.map((person) => [person.id, person]));
	const parts: React.ReactNode[] = [];
	let last = 0;
	for (const match of body.matchAll(MENTION_TOKEN)) {
		if (match.index > last) parts.push(body.slice(last, match.index));
		const person = byId.get(match[1]!);
		parts.push(
			<span key={match.index} className="font-medium text-kumo-brand">
				@<bdi>{person ? mentionLabel(person) : t`Unknown user`}</bdi>
			</span>,
		);
		last = match.index + match[0].length;
	}
	if (last < body.length) parts.push(body.slice(last));
	return <>{parts}</>;
}

/** The `@query` the caret is in, if any, and where it starts. */
function findTrigger(text: string, caret: number): { from: number; query: string } | null {
	const match = MENTION_TRIGGER.exec(text.slice(0, caret));
	if (!match) return null;
	return { from: caret - match[1]!.length - 1, query: match[1]! };
}

/**
 * Suggests people as the user types `@` in a textarea. Returns props for the
 * textarea and the listbox to render beneath it.
 */
export function useMentionPicker({
	entry,
	draft,
	onDraftChange,
	textareaRef,
}: {
	entry: EditorialEntry | null;
	draft: MentionDraft;
	onDraftChange: (draft: MentionDraft) => void;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
	const listboxId = React.useId();
	const [caret, setCaret] = React.useState(0);
	const [activeIndex, setActiveIndex] = React.useState(0);
	const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);
	const trigger = findTrigger(draft.text, caret);
	const open = trigger !== null && trigger.from !== dismissedAt && entry !== null;

	React.useEffect(() => {
		if (dismissedAt !== null && trigger?.from !== dismissedAt) setDismissedAt(null);
	}, [dismissedAt, trigger?.from]);

	const query = useDebouncedValue(trigger?.query ?? "", SEARCH_DEBOUNCE_MS);

	const { data: people = [] } = useQuery({
		queryKey: ["editorial-mentionable", entry?.collection, entry?.id, query],
		queryFn: () => fetchEditorialMentionable(entry!, query),
		enabled: open,
		staleTime: 30_000,
		placeholderData: (previous) => previous,
	});
	const showList = open && people.length > 0;
	const active = Math.min(activeIndex, people.length - 1);

	React.useEffect(() => {
		setActiveIndex(0);
	}, [trigger?.query]);

	const pick = (person: EditorialPerson) => {
		if (!trigger) return;
		const label = `@${mentionLabel(person)}`;
		const inserted = `${label} `;
		const next = editDraft(draft, trigger.from, caret, inserted);
		onDraftChange({
			text: next.text,
			mentions: [
				...next.mentions,
				{ id: person.id, from: trigger.from, to: trigger.from + label.length },
			],
		});
		const end = trigger.from + inserted.length;
		setCaret(end);
		requestAnimationFrame(() => textareaRef.current?.setSelectionRange(end, end));
	};

	const syncCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>) =>
		setCaret(event.currentTarget.selectionStart);

	/** Handles a key the picker owns, returning whether it did. */
	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!showList) return false;
		switch (event.key) {
			case "ArrowDown":
				setActiveIndex((active + 1) % people.length);
				break;
			case "ArrowUp":
				setActiveIndex((active - 1 + people.length) % people.length);
				break;
			case "Enter":
			case "Tab":
				if (event.metaKey || event.ctrlKey) return false;
				pick(people[active]!);
				break;
			case "Escape":
				setDismissedAt(trigger.from);
				break;
			default:
				return false;
		}
		event.preventDefault();
		return true;
	};

	return {
		textareaProps: {
			role: "combobox",
			"aria-autocomplete": "list" as const,
			"aria-expanded": showList,
			"aria-controls": listboxId,
			"aria-activedescendant": showList ? `${listboxId}-${active}` : undefined,
			onSelect: syncCaret,
			onClick: syncCaret,
		},
		syncCaret,
		handleKeyDown,
		listbox: (
			<MentionListbox
				id={listboxId}
				people={people}
				hidden={!showList}
				activeIndex={active}
				onHover={setActiveIndex}
				onPick={pick}
			/>
		),
	};
}

function MentionListbox({
	id,
	people,
	hidden,
	activeIndex,
	onHover,
	onPick,
}: {
	id: string;
	people: EditorialPerson[];
	hidden: boolean;
	activeIndex: number;
	onHover: (index: number) => void;
	onPick: (person: EditorialPerson) => void;
}) {
	const { t } = useLingui();
	return (
		<ul
			id={id}
			role="listbox"
			aria-label={t`People to mention`}
			className={cn(
				"max-h-48 overflow-y-auto rounded-md border border-kumo-line bg-kumo-base p-1 shadow-sm",
				hidden && "hidden",
			)}
		>
			{people.map((person, index) => (
				// oxlint-disable-next-line click-events-have-key-events -- keyboard selection is handled on the combobox textarea
				<li
					key={person.id}
					id={`${id}-${index}`}
					role="option"
					aria-selected={index === activeIndex}
					className={cn(
						"flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm",
						index === activeIndex ? "bg-kumo-interact/50" : "hover:bg-kumo-interact/30",
					)}
					onMouseEnter={() => onHover(index)}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => onPick(person)}
				>
					{person.avatarUrl ? (
						<img src={person.avatarUrl} alt="" className="size-5 rounded-full object-cover" />
					) : null}
					<span className="truncate">{mentionLabel(person)}</span>
				</li>
			))}
		</ul>
	);
}
