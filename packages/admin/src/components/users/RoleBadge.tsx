import { t } from "@lingui/core/macro";
import { cn } from "../../lib/utils";

/** Role level to name mapping */
const ROLE_CONFIG: Record<number, { label: string; color: string; description: string }> = {
	10: {
		label: t`Subscriber`,
		color: "gray",
		description: t`Can view content`,
	},
	20: {
		label: t`Contributor`,
		color: "blue",
		description: t`Can create content`,
	},
	30: {
		label: t`Author`,
		color: "green",
		description: t`Can publish own content`,
	},
	40: {
		label: t`Editor`,
		color: "purple",
		description: t`Can manage all content`,
	},
	50: {
		label: t`Admin`,
		color: "red",
		description: t`Full access`,
	},
};

/** Get role config, with fallback for unknown roles */
export function getRoleConfig(role: number) {
	return (
		ROLE_CONFIG[role] ?? {
			label: t`Role ${role}`,
			color: "gray",
			description: t`Unknown role`,
		}
	);
}

/** Get role label from role level */
export function getRoleLabel(role: number): string {
	return getRoleConfig(role).label;
}

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
			title={showDescription ? undefined : config.description}
		>
			{config.label}
			{showDescription && <span className="ml-1 opacity-75">- {config.description}</span>}
		</span>
	);
}

/** List of all roles for dropdowns */
export const ROLES = [
	{ value: 10, label: "Subscriber", description: "Can view content" },
	{ value: 20, label: "Contributor", description: "Can create content" },
	{ value: 30, label: "Author", description: "Can publish own content" },
	{ value: 40, label: "Editor", description: "Can manage all content" },
	{ value: 50, label: "Admin", description: "Full access" },
];
