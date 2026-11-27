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
const MENTION_TRIGGER = /(?<![A-Za-z0-9/])@([^\s@]{0,30})$/;
const TYPED_TOKEN_START = /<@/g;
const WORD_START = /^[\p{L}\p{N}\p{M}]/u;

export function mentionLabel(person: Pick<EditorialPerson, "name">, unnamedLabel: string): string {
	return person.name?.trim() || unnamedLabel;
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
	labels: { unknown: string; unnamed: string },
): MentionDraft {
	const byId = new Map(people.map((person) => [person.id, person]));
	const mentions: DraftMention[] = [];
	let text = "";
	let last = 0;
	for (const match of body.matchAll(MENTION_TOKEN)) {
		text += body.slice(last, match.index);
		const id = match[1]!;
		const person = byId.get(id);
		const label = `@${person ? mentionLabel(person, labels.unnamed) : labels.unknown}`;
		mentions.push({ id, from: text.length, to: text.length + label.length });
		text += label;
		last = match.index + match[0].length;
	}
	text += body.slice(last);
	return { text, mentions };
}

/**
 * The stored body for a draft: each remembered mention range becomes its
 * person's token. A `<@` typed as text gets a zero-width space so it can't be
 * read as a token.
 */
export function draftToBody(draft: MentionDraft): string {
	const typed = (text: string) => text.replace(TYPED_TOKEN_START, "<\u200B@");
	let body = "";
	let last = 0;
	for (const mention of draft.mentions.toSorted((a, b) => a.from - b.from)) {
		body += `${typed(draft.text.slice(last, mention.from))}<@${mention.id}>`;
		last = mention.to;
	}
	body += typed(draft.text.slice(last));
	return body.trim();
}

/**
 * Replaces `text.slice(from, to)` with `insert`. Mentions after the change
 * move with their text; a mention the change touches, or that the change
 * leaves a letter, digit or combining mark straight after, is no longer a
 * mention.
 */
export function editDraft(
	draft: MentionDraft,
	from: number,
	to: number,
	insert: string,
): MentionDraft {
	const shift = insert.length - (to - from);
	const after = insert + draft.text.slice(to);
	const mentions = draft.mentions.flatMap((mention) => {
		if (mention.to < from || (mention.to === from && !WORD_START.test(after))) return [mention];
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
				@<bdi>{person ? mentionLabel(person, t`Unnamed user`) : t`Unknown user`}</bdi>
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
	const { t } = useLingui();
	const listboxId = React.useId();
	const [caret, setCaret] = React.useState(0);
	const pendingCaret = React.useRef<number | null>(null);

	React.useLayoutEffect(() => {
		if (pendingCaret.current === null) return;
		textareaRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = null;
	});
	const [activeIndex, setActiveIndex] = React.useState(0);
	const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);
	const found = findTrigger(draft.text, caret);
	const trigger =
		found &&
		!draft.mentions.some((mention) => found.from >= mention.from && found.from < mention.to)
			? found
			: null;
	const open = trigger !== null && trigger.from !== dismissedAt && entry !== null;

	React.useEffect(() => {
		if (dismissedAt !== null && trigger?.from !== dismissedAt) setDismissedAt(null);
	}, [dismissedAt, trigger?.from]);

	const query = useDebouncedValue(trigger?.query ?? "", SEARCH_DEBOUNCE_MS);

	const { data: results = [], isPlaceholderData } = useQuery({
		queryKey: ["editorial-mentionable", entry?.collection, entry?.id, query],
		queryFn: () => fetchEditorialMentionable(entry!, query),
		enabled: open,
		staleTime: 30_000,
		placeholderData: (previous) => previous,
	});
	const typed = trigger?.query ?? "";
	const term = typed.trim().toLowerCase();
	// Until results for what's typed arrive, offer only earlier results that still match it.
	const people =
		query === typed && !isPlaceholderData
			? results
			: results.filter((person) => !term || person.name?.toLowerCase().includes(term));
	const showList = open && people.length > 0;
	const active = Math.min(activeIndex, people.length - 1);

	React.useEffect(() => {
		setActiveIndex(0);
	}, [trigger?.query]);

	const pick = (person: EditorialPerson) => {
		if (!trigger) return;
		const label = `@${mentionLabel(person, t`Unnamed user`)}`;
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
		pendingCaret.current = end;
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
				if (event.metaKey || event.ctrlKey || event.shiftKey) return false;
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
	const listRef = React.useRef<HTMLUListElement>(null);
	React.useEffect(() => {
		if (!hidden) listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
	}, [hidden, activeIndex]);
	return (
		<ul
			ref={listRef}
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
					<span className="truncate">{mentionLabel(person, t`Unnamed user`)}</span>
				</li>
			))}
		</ul>
	);
}
