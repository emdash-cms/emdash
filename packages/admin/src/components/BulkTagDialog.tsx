import { Badge, Button, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle, MinusCircle, Question, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	bulkTagPosts,
	createTerm,
	fetchTerms,
	type BulkTagResult,
	type BulkTagSource,
	type TaxonomyTerm,
} from "../lib/api/taxonomies.js";
import { DialogError } from "./DialogError.js";

const NEWLINES = /\r?\n/;

function uniqueTerms(terms: TaxonomyTerm[]): TaxonomyTerm[] {
	const groups = new Map<string, TaxonomyTerm>();
	for (const term of terms) {
		groups.set(term.translationGroup ?? term.id, term);
		for (const child of uniqueTerms(term.children)) {
			groups.set(child.translationGroup ?? child.id, child);
		}
	}
	return [...groups.values()];
}

export interface SelectedBulkTagPost {
	collection: string;
	id: string;
	title: string;
	locale?: string;
}

function ResultBadge({ status }: { status: BulkTagResult["status"] }) {
	const { t } = useLingui();
	const Icon =
		status === "skipped"
			? MinusCircle
			: status === "unmatched"
				? Question
				: status === "failed"
					? WarningCircle
					: CheckCircle;
	const variant =
		status === "skipped"
			? "secondary"
			: status === "unmatched"
				? "warning"
				: status === "failed"
					? "error"
					: "success";
	const label =
		status === "ready"
			? t`Ready`
			: status === "added"
				? t`Added`
				: status === "skipped"
					? t`Already tagged or duplicate`
					: status === "failed"
						? t`Failed`
						: t`Not matched`;

	return (
		<Badge variant={variant} className="gap-1.5">
			<Icon
				className="size-3.5"
				weight={status === "added" || status === "failed" ? "fill" : "regular"}
				aria-hidden="true"
			/>
			{label}
		</Badge>
	);
}

export function BulkTagDialog({
	open,
	onClose,
	onClosed,
	selected,
	activeLocale,
	defaultLocale,
	onApplied,
}: {
	open: boolean;
	onClose: () => void;
	onClosed?: () => void;
	selected?: SelectedBulkTagPost[];
	activeLocale?: string;
	defaultLocale?: string;
	onApplied?: (results: BulkTagResult[]) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const termLocale = activeLocale ?? defaultLocale ?? "en";
	const {
		data: terms = [],
		isLoading,
		isError: termsFailed,
		isFetching: termsFetching,
		refetch: refetchTerms,
	} = useQuery({
		enabled: open,
		queryKey: [
			"taxonomy-terms",
			"tag",
			termLocale,
			{ includeCounts: false, resolveFallback: true },
		],
		queryFn: () =>
			fetchTerms("tag", { locale: termLocale, includeCounts: false, resolveFallback: true }),
	});
	const options = uniqueTerms(terms);
	const [termId, setTermId] = React.useState("");
	const [creating, setCreating] = React.useState(false);
	const [newLabel, setNewLabel] = React.useState("");
	const [urls, setUrls] = React.useState("");
	const [review, setReview] = React.useState<BulkTagResult[] | null>(null);
	const [applied, setApplied] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [cacheRefreshFailed, setCacheRefreshFailed] = React.useState(false);
	const reset = () => {
		setTermId("");
		setCreating(false);
		setNewLabel("");
		setUrls("");
		setReview(null);
		setApplied(false);
		setBusy(false);
		setError(null);
		setCacheRefreshFailed(false);
	};

	const sources: BulkTagSource[] = selected
		? selected.map(({ collection, id }) => ({ collection, id }))
		: urls
				.split(NEWLINES)
				.map((url) => url.trim())
				.filter(Boolean)
				.map((url) => ({ url }));
	const results = review ?? [];
	const ready = results.filter((result) => result.status === "ready").length;
	const failed = results.filter((result) => result.status === "failed");
	const added = results.filter((result) => result.status === "added").length;
	const termLabel = options.find((term) => term.id === termId)?.label;

	const create = async () => {
		if (!newLabel.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const term = await createTerm("tag", { label: newLabel.trim(), locale: termLocale });
			await queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", "tag"] });
			setTermId(term.id);
			setCreating(false);
			setNewLabel("");
			setReview(null);
			setApplied(false);
			setCacheRefreshFailed(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t`Could not create tag`);
		} finally {
			setBusy(false);
		}
	};

	const preview = async () => {
		if (!termId || sources.length === 0 || sources.length > 50) {
			setError(t`Choose a tag and enter between 1 and 50 posts.`);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			setReview((await bulkTagPosts(termId, sources)).results);
			setApplied(false);
			setCacheRefreshFailed(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t`Could not review posts`);
		} finally {
			setBusy(false);
		}
	};

	const apply = async (indices: number[], refreshOnly = false) => {
		if (!review || indices.length === 0) return;
		const targets = indices.map((index) => ({ index, reviewed: review[index]! }));
		setBusy(true);
		setError(null);
		try {
			const response = await bulkTagPosts(
				termId,
				targets.map(({ reviewed }) =>
					reviewed.entry
						? { collection: reviewed.entry.collection, id: reviewed.entry.id }
						: reviewed.input,
				),
				true,
				refreshOnly,
			);
			const next = response.results;
			const merged = [...review];
			for (const [position, { index, reviewed }] of targets.entries()) {
				const updated = next[position];
				if (updated) {
					merged[index] = {
						...updated,
						status:
							reviewed.status === "added" && updated.status === "skipped"
								? "added"
								: updated.status,
						input: reviewed.input,
						entry: updated.entry ?? reviewed.entry,
					};
				}
			}
			setReview(merged);
			setApplied(true);
			setCacheRefreshFailed((previous) =>
				refreshOnly ? response.cacheRefreshFailed : previous || response.cacheRefreshFailed,
			);
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", "tag"] });
			void queryClient.invalidateQueries({ queryKey: ["content"] });
			onApplied?.(merged);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t`Could not add tag`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(nextOpen) => !nextOpen && !busy && onClose()}
			onOpenChangeComplete={(nextOpen) => {
				if (nextOpen) return;
				reset();
				onClosed?.();
			}}
			disablePointerDismissal={busy}
		>
			<Dialog
				size="xl"
				className="flex h-[calc(100dvh-2rem)] max-h-[28rem] w-[calc(100vw-2rem)] min-w-0 max-w-3xl flex-col overflow-hidden p-0 sm:w-[calc(100vw-2rem)]"
			>
				<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
					<div className="min-w-0">
						<Dialog.Title className="text-lg font-semibold">{t`Add tag to posts`}</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
							{t`Existing tags stay in place.`}
						</Dialog.Description>
					</div>
					<Button
						type="button"
						variant="ghost"
						shape="square"
						icon={<X className="size-4" aria-hidden="true" />}
						aria-label={t`Close`}
						disabled={busy}
						onClick={onClose}
					/>
				</div>
				<div className="emdash-auto-scrollbar min-h-0 flex-1 space-y-6 overflow-x-hidden overflow-y-auto px-6 py-6">
					{!review ? (
						<>
							<div className="space-y-2">
								{creating ? (
									<div className="flex flex-wrap items-end gap-2">
										<div className="min-w-0 grow basis-full sm:basis-0">
											<Input
												label={t`New tag name`}
												value={newLabel}
												disabled={busy}
												onChange={(event) => setNewLabel(event.target.value)}
											/>
										</div>
										<Button
											type="button"
											variant="primary"
											disabled={busy || termsFailed || !newLabel.trim()}
											onClick={() => void create()}
										>
											{t`Create tag`}
										</Button>
										<Button type="button" variant="ghost" onClick={() => setCreating(false)}>
											{t`Cancel`}
										</Button>
									</div>
								) : (
									<div className="flex flex-wrap items-end gap-2">
										<div className="min-w-0 grow basis-full sm:basis-0">
											<Select
												className="w-full"
												label={t`Tag`}
												placeholder={t`Choose a tag`}
												value={termId}
												disabled={busy || isLoading || termsFailed}
												onValueChange={(value) => {
													setTermId(value ?? "");
													setCacheRefreshFailed(false);
												}}
												items={Object.fromEntries(options.map((term) => [term.id, term.label]))}
											>
												{options.map((term) => (
													<Select.Option key={term.id} value={term.id}>
														{term.label}
													</Select.Option>
												))}
											</Select>
										</div>
										<Button
											type="button"
											variant="outline"
											disabled={busy || isLoading || termsFailed}
											onClick={() => setCreating(true)}
										>
											{t`Create new tag`}
										</Button>
									</div>
								)}
								{isLoading && <p className="text-sm text-kumo-subtle">{t`Loading tags…`}</p>}
								{termsFailed && (
									<div className="flex flex-wrap items-center gap-2">
										<DialogError message={t`Could not load tags.`} />
										<Button
											type="button"
											variant="outline"
											disabled={termsFetching}
											onClick={() => void refetchTerms()}
										>
											{t`Retry loading tags`}
										</Button>
									</div>
								)}
							</div>
							{selected ? (
								<div className="space-y-2">
									<div className="flex items-baseline gap-2 text-sm">
										<h3 className="font-medium">{t`Selected posts`}</h3>
										<span className="text-kumo-subtle">{selected.length}</span>
									</div>
									<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
										{selected.map((post) => (
											<li
												key={post.id}
												className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
											>
												<span className="min-w-0 break-words font-medium">{post.title}</span>
												{post.locale && (
													<span className="shrink-0 text-kumo-subtle">{post.locale}</span>
												)}
											</li>
										))}
									</ul>
								</div>
							) : (
								<InputArea
									className="w-full"
									label={t`Post URLs (one per line)`}
									rows={4}
									value={urls}
									disabled={busy}
									onChange={(event) => setUrls(event.target.value)}
									placeholder={t`https://example.com/blog/my-post`}
								/>
							)}
						</>
					) : (
						<div aria-live="polite" className="space-y-5">
							{applied ? (
								<div className="flex items-center gap-3">
									<div
										className={`flex size-10 shrink-0 items-center justify-center rounded-full ${failed.length ? "bg-kumo-warning-tint text-kumo-warning" : "bg-kumo-success-tint text-kumo-success"}`}
									>
										{failed.length ? (
											<WarningCircle className="size-5" weight="fill" aria-hidden="true" />
										) : (
											<CheckCircle className="size-5" weight="fill" aria-hidden="true" />
										)}
									</div>
									<div className="min-w-0">
										<h3 dir="auto" className="text-lg font-semibold">
											{failed.length
												? t`${added} tagged · ${failed.length} failed`
												: added === 1
													? t`1 post tagged`
													: t`${added} posts tagged`}
										</h3>
										<p className="text-sm text-kumo-subtle">{termLabel}</p>
									</div>
								</div>
							) : (
								<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-kumo-tint px-4 py-3 text-sm">
									<div className="min-w-0">
										<p className="text-kumo-subtle">{t`Tag`}</p>
										<p className="font-semibold">{termLabel}</p>
									</div>
									<span dir="auto" className="text-kumo-subtle">
										{t`${ready} of ${results.length} ready`}
									</span>
								</div>
							)}
							<div className="space-y-2">
								<h3 className="text-sm font-medium">{applied ? t`Results` : t`Review posts`}</h3>
								<ul className="divide-y divide-kumo-line rounded-lg border border-kumo-line text-sm">
									{results.map((result, index) => (
										<li
											key={index}
											className="flex flex-col items-start gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
										>
											<div className="min-w-0">
												<p className="break-words font-medium">
													{result.entry
														? result.entry.title
														: "url" in result.input
															? result.input.url
															: result.input.id}
												</p>
												{result.entry ? (
													<p className="text-xs text-kumo-subtle">{result.entry.locale}</p>
												) : result.status === "unmatched" ? (
													<p className="text-xs text-kumo-subtle">
														{result.reason === "ambiguous"
															? t`More than one post matches this link`
															: t`No exact match on this site`}
													</p>
												) : null}
											</div>
											<span className="self-end sm:self-auto">
												<ResultBadge status={result.status} />
											</span>
										</li>
									))}
								</ul>
							</div>
							{cacheRefreshFailed && (
								<p role="status" className="text-sm text-kumo-warning">
									{t`Tags were saved, but cached pages may still show old tags. Retry the cache refresh.`}
								</p>
							)}
						</div>
					)}
					<DialogError message={error} />
				</div>
				<div className="flex shrink-0 flex-col gap-3 border-t border-kumo-line px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
					{review && !applied && ready > 0 && (
						<p dir="auto" className="text-sm text-kumo-info">
							{t`Tags go live now; draft edits stay unpublished.`}
						</p>
					)}
					<div className="ms-auto flex flex-wrap justify-end gap-2">
						{review && !applied && (
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() => setReview(null)}
							>
								{t`Back`}
							</Button>
						)}
						{(!review || applied || ready === 0) && (
							<Button type="button" variant="outline" disabled={busy} onClick={onClose}>
								{applied || (review && ready === 0) ? t`Done` : t`Cancel`}
							</Button>
						)}
						{applied ? (
							<>
								{failed.length > 0 && (
									<Button
										type="button"
										variant="primary"
										disabled={busy}
										onClick={() =>
											void apply(
												results.flatMap((result, index) =>
													result.status === "failed" ? [index] : [],
												),
											)
										}
									>
										{t`Retry failures`}
									</Button>
								)}
								{cacheRefreshFailed && (
									<Button
										type="button"
										variant="secondary"
										disabled={busy}
										onClick={() =>
											void apply(
												results.flatMap((result, index) =>
													(result.status === "added" || result.status === "skipped") && result.entry
														? [index]
														: [],
												),
												true,
											)
										}
									>
										{t`Retry cache refresh`}
									</Button>
								)}
							</>
						) : review ? (
							ready > 0 && (
								<Button
									type="button"
									variant="primary"
									disabled={busy}
									onClick={() =>
										void apply(
											results.flatMap((result, index) =>
												result.status === "ready" ? [index] : [],
											),
										)
									}
								>
									{busy
										? t`Adding…`
										: ready === 1
											? t`Add tag to 1 post`
											: t`Add tag to ${ready} posts`}
								</Button>
							)
						) : (
							<Button
								type="button"
								variant="primary"
								disabled={busy || isLoading || termsFailed}
								onClick={() => void preview()}
							>
								{busy ? t`Reviewing…` : t`Review posts`}
							</Button>
						)}
					</div>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
