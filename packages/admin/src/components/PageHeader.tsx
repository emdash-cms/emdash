import { Tabs } from "@cloudflare/kumo";
import type { TabsItem } from "@cloudflare/kumo";
import type * as React from "react";

import { cn } from "../lib/utils.js";

type PageHeaderTabsProps =
	| {
			tabs: TabsItem[];
			value: string;
			onValueChange: (value: string) => void;
	  }
	| {
			tabs?: undefined;
			value?: undefined;
			onValueChange?: undefined;
	  };

type PageHeaderProps = PageHeaderTabsProps & {
	title: string;
	description?: string;
	/** Page-level actions. Give the page's main action `variant="primary"`. */
	actions?: React.ReactNode;
	/** Search, filters and view controls for the page's content. */
	tools?: React.ReactNode;
	className?: string;
};

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
	const hasTabs = tabs !== undefined;

	return (
		<header className={cn("grid min-w-0 gap-4 border-b border-kumo-line pb-4", className)}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div
					className={cn("grid min-w-0 flex-[1_1_12rem] gap-1", description && "max-sm:basis-full")}
				>
					<h1 className="flex min-h-9 min-w-0 items-center text-2xl font-semibold leading-tight">
						{title}
					</h1>
					{description && (
						<p className="text-sm leading-5 text-pretty text-kumo-subtle">{description}</p>
					)}
				</div>
				{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
			</div>

			{(hasTabs || tools) && (
				<div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
					{hasTabs && (
						<div className="min-w-0">
							<Tabs
								value={value}
								onValueChange={onValueChange}
								tabs={tabs.map((tab) => ({
									...tab,
									className: cn("flex-1 justify-center text-sm sm:flex-none", tab.className),
								}))}
								className="w-full max-w-full sm:w-fit"
								listClassName="w-full"
							/>
						</div>
					)}
					{tools && (
						<div className="grid min-w-0 flex-1 gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center">
							{tools}
						</div>
					)}
				</div>
			)}
		</header>
	);
}
