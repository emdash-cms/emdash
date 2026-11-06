import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchEditorialMentionable,
	type EditorialEntry,
	type EditorialPerson,
} from "../../lib/api/editorial-threads.js";
import { cn } from "../../lib/utils.js";

const MENTION_TOKEN = /<@([^<>\s]{1,64})>/g;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const MENTION_TRIGGER = /(?:^|\s)@([^\s@]{0,30})$/;

export function mentionLabel(person: Pick<EditorialPerson, "id" | "name">): string {
	return person.name?.trim() || person.id;
}

/**
 * Comment text as the composer shows it: each `<@USER_ID>` token becomes
 * `@Name`, and the people it names are remembered so the tokens can be put
 * back on save.
 */
export interface MentionDraft {
	text: string;
	mentions: EditorialPerson[];
}

export function bodyToDraft(body: string, people: EditorialPerson[]): MentionDraft {
	const byId = new Map(people.map((person) => [person.id, person]));
	const mentions = new Map<string, EditorialPerson>();
	const text = body.replace(MENTION_TOKEN, (token, id: string) => {
		const person = byId.get(id);
		if (!person) return token;
		mentions.set(id, person);
		return `@${mentionLabel(person)}`;
	});
	return { text, mentions: [...mentions.values()] };
}

/** The stored body for a draft: each `@Name` of a picked person becomes their token. */
export function draftToBody(draft: MentionDraft): string {
	const people = draft.mentions.toSorted((a, b) => mentionLabel(b).length - mentionLabel(a).length);
	let body = draft.text;
	for (const person of people) {
		const label = mentionLabel(person).replace(REGEX_SPECIAL, "\\$&");
		body = body.replace(new RegExp(`@${label}(?![\\p{L}\\p{N}_])`, "gu"), `<@${person.id}>`);
	}
	return body.trim();
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

	const { data: people = [] } = useQuery({
		queryKey: ["editorial-mentionable", entry?.collection, entry?.id, trigger?.query ?? ""],
		queryFn: () => fetchEditorialMentionable(entry!, trigger?.query ?? ""),
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
		const inserted = `@${mentionLabel(person)} `;
		const text = draft.text.slice(0, trigger.from) + inserted + draft.text.slice(caret);
		const mentions = draft.mentions.some((known) => known.id === person.id)
			? draft.mentions
			: [...draft.mentions, person];
		onDraftChange({ text, mentions });
		const next = trigger.from + inserted.length;
		setCaret(next);
		requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next, next));
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
				// Focus stays on the textarea, which handles keyboard selection.
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
