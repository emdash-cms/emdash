import { compareInstants, parseAtUri, parseInstant, type ParsedInstant } from "./validation.js";

export const PROFILE_COLLECTION = "com.emdashcms.experimental.package.profile";
export const RELEASE_COLLECTION = "com.emdashcms.experimental.package.release";

export const LISTING_LABELS = {
	passed: "listing-passed",
	pending: "listing-pending",
	review: "listing-review",
	error: "listing-error",
	blocked: "listing-blocked",
	overridden: "listing-overridden",
	takedown: "!takedown",
} as const;

export type ListingLabelValue = (typeof LISTING_LABELS)[keyof typeof LISTING_LABELS];
export type ListingSubjectKind = "profile" | "release";

export interface ListingLabelEvent {
	ver: 1;
	src: string;
	uri: string;
	val: ListingLabelValue | (string & {});
	cts: string;
	cid?: string;
	neg?: boolean;
	exp?: string;
}

export interface ReducedListingLabel {
	key: string;
	winner: ListingLabelEvent;
	active: boolean;
	collision: readonly ListingLabelEvent[];
}

export interface ListingLabelReduction {
	states: readonly ReducedListingLabel[];
	byKey: ReadonlyMap<string, ReducedListingLabel>;
}

export function listingLabelKey(label: Pick<ListingLabelEvent, "src" | "uri" | "val">): string {
	return `${label.src}\u0000${label.uri}\u0000${label.val}`;
}

function sameEvent(left: ListingLabelEvent, right: ListingLabelEvent): boolean {
	return (
		left.ver === right.ver &&
		left.src === right.src &&
		left.uri === right.uri &&
		left.cid === right.cid &&
		left.val === right.val &&
		(left.neg === true) === (right.neg === true) &&
		left.cts === right.cts &&
		left.exp === right.exp
	);
}

function isActiveAt(label: ListingLabelEvent, now: ParsedInstant): boolean {
	return (
		label.neg !== true &&
		(label.exp === undefined || compareInstants(parseInstant(label.exp, "label.exp"), now) > 0)
	);
}

export function isListingLabelActive(
	label: ListingLabelEvent,
	evaluatedAt: Date | string,
): boolean {
	return isActiveAt(label, parseInstant(evaluatedAt, "evaluatedAt"));
}

export function reduceListingLabels(
	labels: readonly ListingLabelEvent[],
	evaluatedAt: Date | string,
): ListingLabelReduction {
	const now = parseInstant(evaluatedAt, "evaluatedAt");
	const streams = new Map<string, { label: ListingLabelEvent; cts: ParsedInstant }[]>();
	for (const label of labels) {
		const key = listingLabelKey(label);
		const entry = { label, cts: parseInstant(label.cts, "label.cts") };
		const stream = streams.get(key);
		if (stream) stream.push(entry);
		else streams.set(key, [entry]);
	}

	const states: ReducedListingLabel[] = [];
	for (const [key, stream] of streams) {
		const winners = stream.filter((candidate) =>
			stream.every((other) => compareInstants(candidate.cts, other.cts) >= 0),
		);
		const winner = winners[0];
		if (!winner) continue;
		const collision = winners.some((candidate) => !sameEvent(candidate.label, winner.label))
			? winners.map((candidate) => candidate.label)
			: [];
		states.push({
			key,
			winner: winner.label,
			active: collision.length === 0 && isActiveAt(winner.label, now),
			collision,
		});
	}
	states.sort((left, right) => left.key.localeCompare(right.key));
	return { states, byKey: new Map(states.map((state) => [state.key, state])) };
}

export function subjectKindFromUri(uri: string): ListingSubjectKind | null {
	let collection: string;
	try {
		collection = parseAtUri(uri, "subject.uri").collection;
	} catch {
		return null;
	}
	if (collection === PROFILE_COLLECTION) return "profile";
	if (collection === RELEASE_COLLECTION) return "release";
	return null;
}
