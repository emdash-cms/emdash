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
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold leading-tight">{title}</h1>
					{description && (
						<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">{description}</p>
					)}
				</div>
				{actions && (
					<div className="flex shrink-0 justify-end gap-2 self-end sm:self-auto">{actions}</div>
				)}
			</div>

			<div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
				<div className="min-w-0">
					<Tabs
						value={value}
						onValueChange={onValueChange}
						tabs={tabs}
						className="w-fit max-w-full"
					/>
				</div>
				{tools && (
					<div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center lg:justify-end">
						{tools}
					</div>
				)}
			</div>
		</header>
	);
}
