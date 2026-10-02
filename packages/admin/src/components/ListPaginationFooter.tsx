import { Pagination } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

export interface ListPagination {
	page: number;
	perPage: number;
	totalCount: number;
	isPending: boolean;
	onPageChange: (page: number) => void;
	onPageSizeChange: (perPage: number) => void;
}

/** Above this many pages the page picker is a number input instead of a dropdown. */
const MAX_PAGE_DROPDOWN_ITEMS = 100;

interface ListPaginationFooterProps {
	pagination: ListPagination;
	pageSizes: number[];
	/** Accessible name of the pagination navigation. */
	label: string;
}

/**
 * Numbered pagination pinned to the bottom of the admin's scrolling `<main>`.
 * Render it as the last child of a `flex min-h-full flex-col` page so short
 * lists keep it at the bottom of the viewport.
 */
export function ListPaginationFooter({ pagination, pageSizes, label }: ListPaginationFooterProps) {
	const { t } = useLingui();
	const paginationRootRef = React.useRef<HTMLElement>(null);
	const requestRef = React.useRef<{
		focusTarget: HTMLElement | null;
		fallback: "page" | "page-size";
		sawPending: boolean;
	} | null>(null);

	const rememberRequest = (fallback: "page" | "page-size") => {
		requestRef.current = {
			focusTarget: document.activeElement instanceof HTMLElement ? document.activeElement : null,
			fallback,
			sawPending: false,
		};
	};
	const requestPage = (nextPage: number) => {
		if (pagination.isPending || nextPage === pagination.page) return;
		const pageCount = Math.max(1, Math.ceil(pagination.totalCount / pagination.perPage));
		if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > pageCount) return;
		rememberRequest("page");
		pagination.onPageChange(nextPage);
	};
	const requestPageSize = (nextPerPage: number) => {
		if (
			pagination.isPending ||
			nextPerPage === pagination.perPage ||
			!pageSizes.includes(nextPerPage)
		) {
			return;
		}
		rememberRequest("page-size");
		pagination.onPageSizeChange(nextPerPage);
	};
	// The controls are inert while a page loads, which drops focus from them.
	// Return it once the requested page settles, unless the user has moved it.
	// Page changes also run this, so a request served without loading (a
	// cached page) is dropped instead of claiming a later, unrelated load.
	React.useEffect(() => {
		const request = requestRef.current;
		if (!request) return;
		if (pagination.isPending) {
			request.sawPending = true;
			return;
		}
		requestRef.current = null;
		const focusLost = !document.activeElement || document.activeElement === document.body;
		if (!request.sawPending || !focusLost) return;
		let focusTarget = request.focusTarget;
		if (!focusTarget?.isConnected || focusTarget.matches(":disabled")) {
			const slot =
				request.fallback === "page-size" ? "pagination-page-size" : "pagination-controls";
			focusTarget =
				paginationRootRef.current?.querySelector<HTMLElement>(
					`[data-slot="${slot}"] [role="combobox"], [data-slot="${slot}"] input, [data-slot="${slot}"] button:not(:disabled)`,
				) ?? null;
		}
		focusTarget?.focus({ preventScroll: true });
	}, [pagination.page, pagination.perPage, pagination.isPending]);

	return (
		<footer
			ref={paginationRootRef}
			className="sticky -bottom-6 z-10 -mx-6 mt-auto -mb-6 flex min-h-12 min-w-0 shrink-0 items-center border-t border-kumo-line bg-kumo-elevated px-6 py-1"
		>
			<Pagination
				page={pagination.page}
				setPage={requestPage}
				perPage={pagination.perPage}
				totalCount={pagination.totalCount}
				className="flex-wrap gap-y-3"
				labels={{
					navigation: label,
					firstPage: t`First page`,
					previousPage: t`Previous page`,
					nextPage: t`Next page`,
					lastPage: t`Last page`,
					pageNumber: t`Page number`,
					pageSize: t`Page size`,
				}}
			>
				<Pagination.Info className="min-w-fit">
					{({ pageShowingRange, totalCount }) => (
						<span role="status">{t`Showing ${pageShowingRange} of ${totalCount ?? 0}`}</span>
					)}
				</Pagination.Info>
				<Pagination.Separator className="hidden sm:block" />
				<div inert={pagination.isPending || undefined} className="contents">
					<Pagination.PageSize
						value={pagination.perPage}
						onChange={requestPageSize}
						options={pageSizes}
						label={t`Per page`}
					/>
					<Pagination.Controls
						pageSelector={
							Math.ceil(pagination.totalCount / pagination.perPage) <= MAX_PAGE_DROPDOWN_ITEMS
								? "dropdown"
								: "input"
						}
						className="basis-full sm:basis-auto rtl:[&_svg]:-scale-x-100"
					/>
				</div>
			</Pagination>
		</footer>
	);
}
