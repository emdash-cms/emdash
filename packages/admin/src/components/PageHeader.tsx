import { Tabs } from "@cloudflare/kumo";
import type { TabsItem } from "@cloudflare/kumo";
import type * as React from "react";

import { cn } from "../lib/utils.js";

interface PageHeaderProps {
	tabs: TabsItem[];
	value: string;
	onValueChange: (value: string) => void;
	children?: React.ReactNode;
	className?: string;
}

export function PageHeader({ tabs, value, onValueChange, children, className }: PageHeaderProps) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-3 border-b border-kumo-line pb-3 sm:flex-row sm:items-center sm:justify-between",
				className,
			)}
		>
			<div className="min-w-0 sm:flex-1">
				<Tabs
					value={value}
					onValueChange={onValueChange}
					tabs={tabs}
					className="w-fit max-w-full"
				/>
			</div>
			{children && <div className="flex shrink-0 justify-end gap-2">{children}</div>}
		</div>
	);
}
