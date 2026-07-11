/**
 * References Sidebar for Content Editor
 *
 * Read-only "Referenced by" panel shown in the content editor sidebar for
 * existing entries. For each relation whose child side is the entry's
 * collection, it lists the parent entries that reference the entry being
 * edited (the reverse direction of the parent-side reference field renderer).
 *
 * The panel renders nothing when there are no applicable relations, when the
 * relations read fails (e.g. the viewer lacks `schema:read`, a 403), or when
 * every applicable relation has an empty parents list — so collections that
 * nobody references stay out of the way rather than showing an empty state.
 */

import { Badge, Button, Loader, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { fetchCollections } from "../lib/api";
import {
	type EntryRef,
	type RelationDef,
	fetchReferenceParents,
	fetchRelations,
} from "../lib/api/relations.js";
import { cn } from "../lib/utils.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

interface ReferencesSidebarProps {
	collection: string;
	entryId: string;
	/** Locale of the entry being edited. Scopes the relation definitions read so
	 * labels localize to the entry's translation. */
	entryLocale?: string;
	/** Applied to the root element. The panel renders nothing (no chrome) when
	 * there are no backlinks, so the caller passes section padding/border here
	 * rather than wrapping — an empty wrapper would leave a stray gap. */
	className?: string;
}

interface ParentsState {
	items: EntryRef[];
	nextCursor?: string;
	loading: boolean;
}

const PAGE_SIZE = 50;

export function ReferencesSidebar({
	collection,
	entryId,
	entryLocale,
	className,
}: ReferencesSidebarProps) {
	const { t } = useLingui();
	const relationsQuery = useQuery({
		queryKey: ["relations", entryLocale ?? null],
		queryFn: () => fetchRelations(entryLocale),
		// A 403 means the viewer genuinely lacks `schema:read`; retrying just adds
		// latency before we hide the panel, which is the desired outcome.
		retry: false,
	});

	// Group headings use the parent collection's plural label. The relation only
	// carries `parentLabel` (the singular field label), so map slugs to their
	// plural display name; the query is shared with the rest of the admin.
	const collectionsQuery = useQuery({
		queryKey: ["collections"],
		queryFn: fetchCollections,
	});
	const pluralLabelBySlug = React.useMemo(() => {
		const map = new Map<string, string>();
		for (const c of collectionsQuery.data ?? []) map.set(c.slug, c.label);
		return map;
	}, [collectionsQuery.data]);

	const applicableRelations = React.useMemo(
		() => (relationsQuery.data ?? []).filter((r) => r.childCollection === collection),
		[relationsQuery.data, collection],
	);

	// Per-relation parents pagination, keyed by relation id. First pages are
	// loaded on demand (effect below) once the relations list resolves; manual
	// "Load more" advances the cursor for an individual relation.
	const [parentsByRel, setParentsByRel] = React.useState<Record<string, ParentsState>>({});

	// Dump stale state and load the first page for each applicable relation.
	// Re-runs when the entry, collection, or applicable relation set changes.
	React.useEffect(() => {
		let cancelled = false;
		// New entry/relation slice — start from a clean slate so cursor keys from
		// a previously displayed entry never bleed through.
		setParentsByRel({});
		void (async () => {
			for (const rel of applicableRelations) {
				try {
					// The edge endpoints resolve a relation by id or translation_group,
					// never by `name` — passing the group mirrors the children flow.
					const res = await fetchReferenceParents(collection, entryId, rel.translationGroup, {
						limit: PAGE_SIZE,
					});
					if (cancelled) return;
					setParentsByRel((prev) => ({
						...prev,
						[rel.id]: { items: res.parents, nextCursor: res.nextCursor, loading: false },
					}));
				} catch {
					if (cancelled) return;
					// A single relation failing (not found, draft-read denied, …)
					// shouldn't crash the panel — record it as empty so the heading
					// still hides once every relation has resolved.
					setParentsByRel((prev) => ({
						...prev,
						[rel.id]: { items: [], nextCursor: undefined, loading: false },
					}));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [applicableRelations, collection, entryId]);

	const loadMore = React.useCallback(
		async (rel: RelationDef) => {
			// Read current cursor synchronously from state to avoid a stale closure
			// when multiple "Load more" clicks queue up.
			let cursor: string | undefined;
			setParentsByRel((prev) => {
				const cur = prev[rel.id];
				if (!cur || !cur.nextCursor || cur.loading) return prev;
				cursor = cur.nextCursor;
				return { ...prev, [rel.id]: { ...cur, loading: true } };
			});
			if (!cursor) return;
			try {
				const res = await fetchReferenceParents(collection, entryId, rel.translationGroup, {
					cursor,
					limit: PAGE_SIZE,
				});
				setParentsByRel((prev) => {
					const cur = prev[rel.id];
					if (!cur) return prev;
					const seen = new Set(cur.items.map((p) => p.id));
					const merged = [...cur.items, ...res.parents.filter((p) => !seen.has(p.id))];
					return {
						...prev,
						[rel.id]: { items: merged, nextCursor: res.nextCursor, loading: false },
					};
				});
			} catch {
				setParentsByRel((prev) => {
					const cur = prev[rel.id];
					return cur ? { ...prev, [rel.id]: { ...cur, loading: false } } : prev;
				});
			}
		},
		[collection, entryId],
	);

	// RENDER GATES (after all hooks) — the panel is optional context. While the
	// relations list is still loading or has errored, stay out of the layout.
	if (relationsQuery.isLoading || relationsQuery.error) return null;
	if (applicableRelations.length === 0) return null;

	const isPopulated = (rel: RelationDef): boolean => (parentsByRel[rel.id]?.items.length ?? 0) > 0;
	if (!applicableRelations.some(isPopulated)) return null;
	const populatedRels = applicableRelations.filter(isPopulated);

	return (
		<div className={cn("space-y-4", className)}>
			<Text bold as="h3">
				{t`Referenced by`}
			</Text>
			<div className="space-y-4">
				{populatedRels.map((rel) => {
					const state = parentsByRel[rel.id];
					// `state` is guarded by `isPopulated` above, but the TS narrowing
					// across the .filter callback doesn't carry through.
					if (!state) return null;
					const heading = pluralLabelBySlug.get(rel.parentCollection) ?? rel.parentLabel;
					return (
						<div key={rel.id} className="space-y-2">
							<h4 className="text-sm font-medium text-kumo-subtle">{heading}</h4>
							<ul className="space-y-2">
								{state.items.map((parent) => {
									const crossLocale =
										!!parent.locale && !!entryLocale && parent.locale !== entryLocale;
									const label = parent.title || parent.slug || parent.id;
									return (
										<li
											key={parent.id}
											className="flex items-center gap-2 rounded-md border bg-kumo-base px-3 py-2"
										>
											<Link
												to="/content/$collection/$id"
												params={{ collection: parent.collection, id: parent.id }}
												search={{ locale: parent.locale ?? undefined }}
												className="group min-w-0 flex-1"
											>
												<div className="truncate text-sm font-medium group-hover:underline">
													{label}
												</div>
												{(parent.slug || crossLocale) && (
													<div className="flex items-center gap-2 text-xs text-kumo-subtle">
														{parent.slug && <span className="truncate">{parent.slug}</span>}
														{crossLocale && <Badge>{parent.locale}</Badge>}
													</div>
												)}
											</Link>
											<RouterLinkButton
												to="/content/$collection/$id"
												params={{ collection: parent.collection, id: parent.id }}
												search={{ locale: parent.locale ?? undefined }}
												target="_blank"
												variant="ghost"
												shape="square"
												size="sm"
												icon={<ArrowSquareOut className="h-4 w-4" />}
												aria-label={t`Open ${label} in a new tab`}
											/>
										</li>
									);
								})}
							</ul>
							{state.nextCursor && (
								<div className="pt-1">
									<Button
										variant="outline"
										size="sm"
										onClick={() => void loadMore(rel)}
										disabled={state.loading}
									>
										{state.loading ? (
											<>
												<Loader size="sm" /> {t`Loading...`}
											</>
										) : (
											t`Load more`
										)}
									</Button>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
