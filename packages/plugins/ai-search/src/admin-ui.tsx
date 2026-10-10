import * as React from "react";

/** A titled group of rows in a bordered card, matching the admin's settings sections. */
export function Section(props: {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	footer?: React.ReactNode;
	children: React.ReactNode;
}) {
	const headingId = React.useId();
	return (
		<section aria-labelledby={headingId} className="space-y-2">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h2 id={headingId} className="text-base font-semibold">
						{props.title}
					</h2>
					{props.description && <p className="text-sm text-kumo-subtle">{props.description}</p>}
				</div>
				{props.actions}
			</div>
			<div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
				{props.children}
			</div>
			{props.footer && <p className="text-xs text-kumo-subtle">{props.footer}</p>}
		</section>
	);
}

export function Row(props: { children: React.ReactNode; className?: string }) {
	return (
		<div className={`flex min-h-12 items-center gap-3 px-4 py-2 ${props.className ?? ""}`}>
			{props.children}
		</div>
	);
}

/** A row's title and optional one-line description. */
export function RowText(props: { title: React.ReactNode; description?: React.ReactNode }) {
	return (
		<span className="block min-w-0">
			<span className="block truncate text-sm font-medium">{props.title}</span>
			{props.description && (
				<span className="block truncate text-xs text-kumo-subtle">{props.description}</span>
			)}
		</span>
	);
}
