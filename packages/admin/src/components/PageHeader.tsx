import { Tabs } from "@cloudflare/kumo";
import type { TabsItem } from "@cloudflare/kumo";
import type * as React from "react";

import { cn } from "../lib/utils.js";

interface PageHeaderProps {
	title: string;
	description?: string;
	tabs: TabsItem[];
	value: string;
	onValueChange: (value: string) => void;
	actions?: React.ReactNode;
	tools?: React.ReactNode;
	className?: string;
}

export function PageHeader({
	title,
	description,
	tabs,
	value,
	onValueChange,
	actions,
	tools,
	className,
}: PageHeaderProps) {
	return (
		<header className={cn("grid min-w-0 gap-4 border-b border-kumo-line pb-4", className)}>
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
				<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">
					{title}
				</h1>
				{actions && <div className="flex shrink-0 justify-end gap-2">{actions}</div>}
				{description && (
					<p className="col-span-2 text-sm leading-5 text-pretty text-kumo-subtle">{description}</p>
				)}
			</div>

			<div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<div className="min-w-0">
					<Tabs
						value={value}
						onValueChange={onValueChange}
						tabs={tabs}
						className="w-full max-w-full sm:w-fit"
						listClassName="w-full"
					/>
				</div>
				{tools && (
					<div className="grid min-w-0 flex-1 gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
						{tools}
					</div>
				)}
			</div>
		</header>
	);
}
