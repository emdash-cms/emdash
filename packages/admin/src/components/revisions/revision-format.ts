import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { RevisionAuthor, RevisionListItem } from "../../lib/api";
import type { CurrentUser } from "../../lib/api/current-user.js";
import { formatDate, isolate, parseTimestamp } from "../../lib/utils.js";

export type AuthorColor = "purple" | "teal" | "blue" | "orange" | "neutral";

const AUTHOR_PALETTE = ["purple", "teal", "blue", "orange"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function fnv1a(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Gives each author a palette colour from a hash of their id. Authors are placed in id order and
 * move to the next free colour on a collision, so two authors only share a colour once the
 * palette runs out.
 */
export function assignAuthorColors(
	authorIds: Iterable<string | null | undefined>,
): ReadonlyMap<string, AuthorColor> {
	const ids = [...new Set([...authorIds].filter((id): id is string => Boolean(id)))].toSorted();
	const taken = new Set<number>();
	const colors = new Map<string, AuthorColor>();
	for (const id of ids) {
		const start = fnv1a(id) % AUTHOR_PALETTE.length;
		let slot = start;
		for (let step = 1; taken.has(slot) && step < AUTHOR_PALETTE.length; step++) {
			slot = (start + step) % AUTHOR_PALETTE.length;
		}
		taken.add(slot);
		colors.set(id, AUTHOR_PALETTE[slot] ?? "neutral");
	}
	return colors;
}

export function authorColorOf(
	colors: ReadonlyMap<string, AuthorColor>,
	authorId: string | null | undefined,
): AuthorColor {
	return (authorId && colors.get(authorId)) || "neutral";
}

/**
 * The people a version names: everyone who edited it since the version before it, or its author
 * when no one is recorded. An entry is `null` for an account that no longer exists.
 */
export function revisionNamed(item: RevisionListItem): Array<RevisionAuthor | null> {
	return item.editedBy ?? [item.author];
}

function soleNamed(item: RevisionListItem): RevisionAuthor | null {
	const named = revisionNamed(item);
	return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * Colours for the people that versions of a loaded list name on their own, shared by the list dots,
 * the view bar and the canvas marks.
 */
export function revisionAuthorColors(
	items: readonly RevisionListItem[],
): ReadonlyMap<string, AuthorColor> {
	return assignAuthorColors(items.map((item) => soleNamed(item)?.id));
}

/**
 * A version's colour: the colour of the one person it names, or neutral when it names several, or
 * only an unknown or deleted account.
 */
export function revisionAuthorColor(
	colors: ReadonlyMap<string, AuthorColor>,
	item: RevisionListItem,
): AuthorColor {
	return authorColorOf(colors, soleNamed(item)?.id);
}

/** Revision timestamps come from SQLite without a zone and are UTC. */
export function revisionDate(createdAt: string): Date {
	return parseTimestamp(createdAt);
}

/** `YYYY-MM-DD` in the viewer's time zone, for grouping versions by day. */
export function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** The element id the revision view gives the block or field a change points at. */
export function revisionTargetElementId(targetId: string): string {
	return `revision-${targetId}`;
}

export interface RevisionFormat {
	/** "Today", "Yesterday", a weekday within the last week, otherwise the date. */
	day(date: Date, now?: Date): string;
	time(date: Date): string;
	/** The day and time together, such as "Today, 9:12 AM". */
	when(date: Date, now?: Date): string;
	/**
	 * The author's name; the viewer's own name for their unnamed account; "Unnamed user" for
	 * someone else's; "Unknown author" when no author was recorded or the account is gone.
	 */
	author(author: RevisionAuthor | null | undefined): string;
	/**
	 * The people a version names, such as "Ana", "Ana and Ben", or "Ana, Ben, and 3 other people",
	 * each named as `author` names them and joined as the locale joins a list. Deleted accounts
	 * count among the others; a list of only deleted accounts reads "Unknown author". With more
	 * than one person, each name is isolated.
	 */
	people(named: readonly (RevisionAuthor | null)[]): string;
}

export function useRevisionFormat(): RevisionFormat {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const locale = i18n.locale;

	return React.useMemo(() => {
		const day = (date: Date, now: Date = new Date()) => {
			const key = localDayKey(date);
			if (key === localDayKey(now)) return t`Today`;
			const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			if (key === localDayKey(new Date(startOfToday.getTime() - DAY_MS / 2))) return t`Yesterday`;
			if (date.getTime() >= startOfToday.getTime() - 6 * DAY_MS) {
				return formatDate(date, locale, { weekday: "long" });
			}
			return formatDate(date, locale, {
				month: "long",
				day: "numeric",
				year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
			});
		};
		const time = (date: Date) => formatDate(date, locale, { hour: "numeric", minute: "2-digit" });
		const when = (date: Date, now?: Date) => {
			if (Number.isNaN(date.getTime())) return "";
			const dayLabel = day(date, now);
			const timeLabel = time(date);
			return t`${dayLabel}, ${timeLabel}`;
		};
		const author = (value: RevisionAuthor | null | undefined) => {
			if (value?.name) return value.name;
			const me = queryClient.getQueryData<CurrentUser>(["currentUser"]);
			if (value && me && value.id === me.id) return me.name || me.email;
			return value ? t`Unnamed user` : t`Unknown author`;
		};
		const list = new Intl.ListFormat(locale, { type: "conjunction" });
		const people = (named: readonly (RevisionAuthor | null)[]) => {
			const names = named
				.filter((person): person is RevisionAuthor => person !== null)
				.slice(0, 2)
				.map((person) => author(person));
			const [first] = names;
			if (first === undefined) return author(null);
			const others = named.length - names.length;
			if (names.length === 1 && others === 0) return first;
			const items = names.map((name) => isolate(name));
			if (others > 0) {
				items.push(plural(others, { one: "# other person", other: "# other people" }));
			}
			return list.format(items);
		};
		return { day, time, when, author, people };
	}, [t, locale, queryClient]);
}
