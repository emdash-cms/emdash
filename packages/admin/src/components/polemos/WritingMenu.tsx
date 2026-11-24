import { Popover } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { apiFetch } from "../../lib/api/client.js";

const ITEMS = [
	["מאמר", "articles"],
	["מבט", "mabatim"],
	["גיליון", "issues"],
	["כותב/ת", "people"],
	["עמוד", "pages"],
] as const;

interface WritingCounts {
	drafts?: number;
	published?: number;
}

async function fetchWritingCounts(): Promise<Record<string, WritingCounts>> {
	const response = await apiFetch("/_emdash/api/plugins/polemos-desk/counts");
	if (!response.ok) return {};
	const body: unknown = await response.json().catch(() => ({}));
	const data =
		body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object"
			? body.data
			: body;
	return data && typeof data === "object" ? (data as Record<string, WritingCounts>) : {};
}

/** Sidebar menu for a new article, מבט, issue, person, or page, with entry counts. */
export function PolemosWritingMenu() {
	const [open, setOpen] = React.useState(false);
	const { data } = useQuery({
		queryKey: ["polemos-writing-counts"],
		queryFn: fetchWritingCounts,
		staleTime: 60_000,
		retry: false,
	});

	return (
		<div className="px-3 pt-2 group-data-[state=collapsed]/sidebar:px-2" data-polemos-new="">
			<Popover open={open} onOpenChange={setOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm font-medium"
						aria-haspopup="menu"
						aria-expanded={open}
					>
						<Plus className="size-4 shrink-0" aria-hidden="true" />
						<span className="truncate group-data-[state=collapsed]/sidebar:sr-only">כתיבה חדשה</span>
					</button>
				</Popover.Trigger>
				<Popover.Content className="w-52 p-1" align="start">
					<div role="menu" aria-label="כתיבה חדשה" className="grid">
						{ITEMS.map(([label, collection]) => {
							const row = data?.[collection];
							const count =
								row && (typeof row.drafts === "number" || typeof row.published === "number")
									? (row.drafts ?? 0) + (row.published ?? 0)
									: null;
							return (
								<Link
									key={collection}
									role="menuitem"
									to="/content/$collection/new"
									params={{ collection }}
									search={{ locale: undefined }}
									className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-kumo-tint"
									onClick={() => setOpen(false)}
								>
									<span>{label}</span>
									{count !== null ? (
										<span className="text-xs text-kumo-subtle tabular-nums" data-polemos-count={collection}>
											{count}
										</span>
									) : null}
								</Link>
							);
						})}
					</div>
				</Popover.Content>
			</Popover>
		</div>
	);
}
