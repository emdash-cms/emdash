import { Button, Collapsible, Loader, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { cn } from "../lib/utils.js";
import { REVISION_LIST_LIMIT, revisionsQueryOptions } from "./revisions/revision-query.js";
import { useRevisionViewContext } from "./revisions/revision-view-context.js";
import { RevisionList } from "./revisions/RevisionList.js";

interface RevisionHistoryProps {
	collection: string;
	entryId: string;
	/** Reserve the inline end of the disclosure header for an external control. */
	reserveHeaderEnd?: boolean;
}

/** The Revisions section of the content settings sidebar: the entry's saved versions by day. */
export function RevisionHistory({
	collection,
	entryId,
	reserveHeaderEnd = false,
}: RevisionHistoryProps) {
	const { t } = useLingui();
	const view = useRevisionViewContext();
	const [isExpanded, setIsExpanded] = React.useState(false);

	const {
		data: list,
		isError,
		isPlaceholderData,
		refetch,
	} = useQuery({
		...revisionsQueryOptions(collection, entryId, view?.listLimit ?? REVISION_LIST_LIMIT),
		enabled: isExpanded,
	});
	const total = list?.total ?? 0;

	return (
		<Collapsible.Root open={isExpanded} onOpenChange={setIsExpanded}>
			<Collapsible.Trigger
				render={
					<Button
						type="button"
						variant="ghost"
						className="relative justify-between"
						style={{
							width: reserveHeaderEnd ? "calc(100% - 1.5rem)" : "calc(100% + 1.5rem)",
							insetInlineStart: "-0.75rem",
						}}
					/>
				}
			>
				<span className="flex items-center gap-1.5">
					<Text as="span" DANGEROUS_className="font-semibold">
						{t`Revisions`}
					</Text>
					{total > 0 && (
						<span className="text-xs font-normal leading-4 text-kumo-subtle">({total})</span>
					)}
				</span>
				<CaretDown
					className={cn(
						"h-4 w-4 text-kumo-subtle transition-transform duration-150 ease-out motion-reduce:transition-none",
						isExpanded && "rotate-180",
					)}
				/>
			</Collapsible.Trigger>

			<Collapsible.Panel
				className="overflow-hidden duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
				style={({ transitionStatus }) => ({
					height:
						transitionStatus === "starting" || transitionStatus === "ending"
							? 0
							: "var(--collapsible-panel-height)",
					transitionProperty: "height",
				})}
			>
				{list ? (
					list.items.length === 0 ? (
						<p className="py-4 text-center text-xs leading-4 text-kumo-subtle">
							{t`No versions yet`}
						</p>
					) : (
						<RevisionList list={list} loadingOlder={isPlaceholderData} />
					)
				) : isError ? (
					<div className="flex flex-col items-center gap-2 py-4 text-center">
						<p className="text-xs leading-4 text-kumo-danger">{t`Couldn't load versions`}</p>
						<Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>
							{t`Try again`}
						</Button>
					</div>
				) : (
					<div className="flex items-center justify-center py-6">
						<Loader />
					</div>
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
