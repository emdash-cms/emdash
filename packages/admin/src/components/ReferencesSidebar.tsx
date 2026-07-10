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

import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	type EntryRef,
	type RelationDef,
	fetchReferenceParents,
	fetchRelations,
} from "../lib/api/relations.js";

interface ReferencesSidebarProps {
	collection: string;
	entryId: string;
	/** Locale of the entry being edited. Scopes the relation definitions read so
	 * labels localize to the entry's translation. */
	entryLocale?: string;
}

interface ParentsState {
	items: EntryRef[];
	nextCursor?: string;
	loading: boolean;
}

const PAGE_SIZE = 50;

export function ReferencesSidebar({ collection, entryId, entryLocale }: ReferencesSidebarProps) {
	const { t } = useLingui();
	const relationsQuery = useQuery({
		queryKey: ["relations", entryLocale ?? null],
		queryFn: () => fetchRelations(entryLocale),
		// A 403 means the viewer genuinely lacks `schema:read`; retrying just adds
		// latency before we hide the panel, which is the desired outcome.
		retry: false,
	});

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
					const res = await fetchReferenceParents(collection, entryId, rel.name, {
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
				const res = await fetchReferenceParents(collection, entryId, rel.name, {
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
		<div className="space-y-4">
			<h3 className="font-semibold">{t`Referenced by`}</h3>
			<div className="space-y-4">
				{populatedRels.map((rel) => {
					const state = parentsByRel[rel.id];
					// `state` is guarded by `isPopulated` above, but the TS narrowing
					// across the .filter callback doesn't carry through.
					if (!state) return null;
					return (
						<div key={rel.id} className="space-y-2">
							<h4 className="text-sm font-medium text-kumo-subtle">{rel.parentLabel}</h4>
							<ul className="space-y-1">
								{state.items.map((parent) => (
									<li key={parent.id}>
										<Link
											to="/content/$collection/$id"
											params={{ collection: parent.collection, id: parent.id }}
											search={{ locale: parent.locale ?? undefined }}
											className="font-medium hover:text-kumo-brand"
										>
											{parent.slug ?? parent.id}
										</Link>
									</li>
								))}
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
