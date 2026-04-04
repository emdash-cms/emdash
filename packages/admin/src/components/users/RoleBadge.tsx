import { useQuery } from "@tanstack/react-query";

import { fetchRoles, type RoleDef } from "../../lib/api/roles.js";
import { cn } from "../../lib/utils";

/** Built-in role config (fallback when API roles haven't loaded) */
const BUILTIN_ROLE_CONFIG: Record<number, { label: string; color: string; description: string }> = {
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

/** Map a hex color to the closest named Tailwind color for badge styling */
function colorToTailwindName(hex: string | null): string {
	if (!hex) return "gray";
	const map: Record<string, string> = {
		"#ef4444": "red", "#f97316": "orange", "#eab308": "yellow",
		"#22c55e": "green", "#3b82f6": "blue", "#8b5cf6": "purple",
		"#ec4899": "pink", "#6b7280": "gray",
	};
	return map[hex.toLowerCase()] ?? "gray";
}

/** Get role config, with fallback for unknown roles */
export function getRoleConfig(role: number, roleDefs?: RoleDef[]) {
	// Check API-provided role definitions first
	if (roleDefs) {
		const def = roleDefs.find((r) => r.level === role);
		if (def) {
			return {
				label: def.label,
				color: def.builtin ? (BUILTIN_ROLE_CONFIG[role]?.color ?? "gray") : colorToTailwindName(def.color),
				description: def.description ?? `Level ${def.level} role`,
			};
		}
	}
	return (
		BUILTIN_ROLE_CONFIG[role] ?? {
			label: `Role ${role}`,
			color: "gray",
			description: "Unknown role",
		}
	);
}

/** Get role label from role level */
export function getRoleLabel(role: number, roleDefs?: RoleDef[]): string {
	return getRoleConfig(role, roleDefs).label;
}

/** Hook to fetch all role definitions for use in dropdowns and badges */
export function useRoleDefs() {
	return useQuery({
		queryKey: ["roleDefs"],
		queryFn: fetchRoles,
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
}

export interface RoleBadgeProps {
	role: number;
	size?: "sm" | "md";
	showDescription?: boolean;
	className?: string;
}

/**
 * Role badge component with semantic colors.
 * Fetches custom role definitions to display dynamic labels and colors.
 */
export function RoleBadge({
	role,
	size = "sm",
	showDescription = false,
	className,
}: RoleBadgeProps) {
	const { data: roleDefs } = useRoleDefs();
	const config = getRoleConfig(role, roleDefs);

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

/** Built-in roles for dropdowns (static fallback) */
export const BUILTIN_ROLES = [
	{ value: 10, label: "Subscriber", description: "Can view content" },
	{ value: 20, label: "Contributor", description: "Can create content" },
	{ value: 30, label: "Author", description: "Can publish own content" },
	{ value: 40, label: "Editor", description: "Can manage all content" },
	{ value: 50, label: "Admin", description: "Full access" },
];

/** @deprecated Use useAllRoles() hook instead for dynamic roles */
export const ROLES = BUILTIN_ROLES;

/** Hook that returns all roles (built-in + custom) for use in dropdowns */
export function useAllRoles() {
	const { data: roleDefs } = useRoleDefs();

	if (!roleDefs) return BUILTIN_ROLES;

	return roleDefs
		.map((r) => ({
			value: r.level,
			label: r.label,
			description: r.description ?? (r.builtin ? BUILTIN_ROLE_CONFIG[r.level]?.description ?? "" : `Level ${r.level} role`),
		}))
		.sort((a, b) => a.value - b.value);
}
