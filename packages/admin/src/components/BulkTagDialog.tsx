import { Button, Dialog, Input, InputArea, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
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

export function BulkTagDialog({
	onClose,
	selected,
	defaultLocale,
	onApplied,
}: {
	onClose: () => void;
	selected?: BulkTagSource[];
	defaultLocale?: string;
	onApplied?: (results: BulkTagResult[]) => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const { data: terms = [], isLoading } = useQuery({
		queryKey: ["taxonomy-terms", "tag", "all"],
		queryFn: () => fetchTerms("tag"),
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

	const sources: BulkTagSource[] =
		selected ??
		urls
			.split(NEWLINES)
			.map((url) => url.trim())
			.filter(Boolean)
			.map((url) => ({ url }));
	const results = review ?? [];
	const ready = results.filter((result) => result.status === "ready").length;
	const failed = results.filter((result) => result.status === "failed");

	const create = async () => {
		if (!newLabel.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const term = await createTerm("tag", { label: newLabel.trim(), locale: defaultLocale });
			await queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", "tag"] });
			setTermId(term.id);
			setCreating(false);
			setNewLabel("");
			setReview(null);
			setApplied(false);
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
			setReview(await bulkTagPosts(termId, sources));
			setApplied(false);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t`Could not review posts`);
		} finally {
			setBusy(false);
		}
	};

	const apply = async (items: BulkTagSource[]) => {
		setBusy(true);
		setError(null);
		try {
			const next = await bulkTagPosts(termId, items, true);
			setReview(
				(previous) =>
					previous?.map(
						(result) =>
							next.find(
								(updated) => JSON.stringify(updated.input) === JSON.stringify(result.input),
							) ?? result,
					) ?? next,
			);
			setApplied(true);
			void queryClient.invalidateQueries({ queryKey: ["taxonomy-terms", "tag"] });
			void queryClient.invalidateQueries({ queryKey: ["content"] });
			onApplied?.(next);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t`Could not add tag`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()} disablePointerDismissal>
			<Dialog size="lg" className="flex max-h-[85vh] flex-col p-6">
				<Dialog.Title className="text-lg font-semibold">{t`Add tag to posts`}</Dialog.Title>
				<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
					{t`Review each post before adding one tag. Existing tags stay in place.`}
				</Dialog.Description>
				<div className="mt-4 min-h-0 space-y-4 overflow-y-auto">
					<Select
						label={t`Tag`}
						value={termId}
						onValueChange={(value) => {
							setTermId(value ?? "");
							setReview(null);
							setApplied(false);
						}}
						items={Object.fromEntries(options.map((term) => [term.id, term.label]))}
					>
						{options.map((term) => (
							<Select.Option key={term.id} value={term.id}>
								{term.label}
							</Select.Option>
						))}
					</Select>
					{isLoading && <p className="text-sm text-kumo-subtle">{t`Loading tags…`}</p>}
					{creating ? (
						<div className="flex flex-wrap items-end gap-2">
							<Input
								label={t`New tag name`}
								value={newLabel}
								onChange={(event) => setNewLabel(event.target.value)}
							/>
							<Button
								type="button"
								disabled={busy || !newLabel.trim()}
								onClick={() => void create()}
							>{t`Create tag`}</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setCreating(false)}
							>{t`Cancel`}</Button>
						</div>
					) : (
						<Button
							type="button"
							variant="outline"
							onClick={() => setCreating(true)}
						>{t`Create new tag`}</Button>
					)}
					{selected ? (
						<p className="text-sm text-kumo-subtle">{t`${selected.length} selected posts`}</p>
					) : (
						<InputArea
							label={t`Post URLs (one per line)`}
							rows={5}
							value={urls}
							onChange={(event) => {
								setUrls(event.target.value);
								setReview(null);
								setApplied(false);
							}}
							placeholder={t`https://example.com/blog/my-post`}
						/>
					)}
					{review && (
						<div aria-live="polite" className="space-y-2">
							<p className="text-sm font-medium">{applied ? t`Results` : t`Review matches`}</p>
							<ul className="max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
								{results.map((result, index) => (
									<li key={index} className="flex justify-between gap-3 px-3 py-2">
										<div className="min-w-0 break-words">
											{result.entry ? (
												<span>
													{result.entry.title} ({result.entry.locale})
												</span>
											) : (
												<span>{"url" in result.input ? result.input.url : result.input.id}</span>
											)}
											{result.status === "unmatched" && (
												<p className="text-kumo-subtle">
													{result.reason === "ambiguous"
														? t`More than one post matches this link`
														: t`No exact match on this site`}
												</p>
											)}
										</div>
										<span className="shrink-0 text-kumo-subtle">
											{result.status === "ready"
												? t`Ready`
												: result.status === "added"
													? t`Added`
													: result.status === "skipped"
														? t`Already tagged or duplicate`
														: result.status === "failed"
															? t`Failed`
															: t`Not matched`}
										</span>
									</li>
								))}
							</ul>
							{!applied && (
								<p className="text-sm text-kumo-subtle">{t`Apply now changes tags immediately on published posts. It does not publish other draft edits.`}</p>
							)}
						</div>
					)}
					<DialogError message={error} />
				</div>
				<div className="mt-5 flex flex-wrap justify-end gap-2">
					<Button type="button" variant="outline" disabled={busy} onClick={onClose}>
						{applied || (review && ready === 0) ? t`Done` : t`Cancel`}
					</Button>
					{applied ? (
						failed.length > 0 && (
							<Button
								type="button"
								disabled={busy}
								onClick={() => void apply(failed.map((result) => result.input))}
							>{t`Retry failures`}</Button>
						)
					) : review ? (
						<Button
							type="button"
							disabled={busy || ready === 0}
							onClick={() => void apply(sources)}
						>
							{busy ? t`Adding…` : t`Apply now`}
						</Button>
					) : (
						<Button type="button" disabled={busy} onClick={() => void preview()}>
							{busy ? t`Reviewing…` : t`Review posts`}
						</Button>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
