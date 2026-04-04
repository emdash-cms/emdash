import { useLingui } from "@lingui/react/macro";

import { cn } from "../../lib/utils";

/** Role level to name mapping */
const ROLE_CONFIG: Record<number, { label: string; color: string; description: string }> = {
	10: {
		label: "Subscriber",
		color: "gray",
		description: "Can view content",
	},
	20: {
		label: "Contributor",
		color: "blue",
		description: "Can create content",
	},
	30: {
		label: "Author",
		color: "green",
		description: "Can publish own content",
	},
	40: {
		label: "Editor",
		color: "purple",
		description: "Can manage all content",
	},
	50: {
		label: "Admin",
		color: "red",
		description: "Full access",
	},
};

/** Get role config, with fallback for unknown roles */
export function getRoleConfig(role: number) {
	return (
		ROLE_CONFIG[role] ?? {
			label: `Role ${role}`,
			color: "gray",
			description: "Unknown role",
		}
	);
}

/** Get role label from role level */
export function getRoleLabel(role: number): string {
	return getRoleConfig(role).label;
}

/**
 * Hook that returns a function to translate role labels at render time.
 * Use this in components that need translated role strings.
 */
export function useTranslatedRoleConfig() {
	const { t } = useLingui();

	const labels: Record<string, string> = {
		Subscriber: t`Subscriber`,
		Contributor: t`Contributor`,
		Author: t`Author`,
		Editor: t`Editor`,
		Admin: t`Admin`,
	};

	const descriptions: Record<string, string> = {
		"Can view content": t`Can view content`,
		"Can create content": t`Can create content`,
		"Can publish own content": t`Can publish own content`,
		"Can manage all content": t`Can manage all content`,
		"Full access": t`Full access`,
		"Unknown role": t`Unknown role`,
	};

	return {
		translateLabel: (label: string) => labels[label] ?? label,
		translateDescription: (description: string) => descriptions[description] ?? description,
	};
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
	const { translateLabel, translateDescription } = useTranslatedRoleConfig();

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
			title={showDescription ? undefined : translateDescription(config.description)}
		>
			{translateLabel(config.label)}
			{showDescription && (
				<span className="ml-1 opacity-75">- {translateDescription(config.description)}</span>
			)}
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
