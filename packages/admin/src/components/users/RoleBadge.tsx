import { useLingui } from "@lingui/react/macro";

import { cn } from "../../lib/utils";
import { getRoleConfig } from "./roleDefinitions.js";

export type { RoleLevelConfig } from "./roleDefinitions.js";

export interface RoleBadgeProps {
	role: number;
	size?: "sm" | "md";
	showDescription?: boolean;
	className?: string;
}

/**
 * Role badge component with semantic colors
 */
export function RoleBadge({
	role,
	size = "sm",
	showDescription = false,
	className,
}: RoleBadgeProps) {
	const { t } = useLingui();
	const config = getRoleConfig(role);

	const colorClasses: Record<string, string> = {
		gray: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
		blue: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
		green: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
		purple: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
		red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
	};

	const sizeClasses = {
		sm: "px-2 py-0.5 text-xs",
		md: "px-2.5 py-1 text-sm",
	};

	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full font-medium",
				sizeClasses[size],
				colorClasses[config.color],
				className,
			)}
			title={showDescription ? undefined : t(config.description)}
		>
			{t(config.label)}
			{showDescription && <span className="ms-1 opacity-75">- {t(config.description)}</span>}
		</span>
	);
}
