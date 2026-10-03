import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Sun, Moon } from "@phosphor-icons/react";

import { useTheme } from "./ThemeProvider";

export function ThemeToggle({
	className,
	iconClassName,
	labelClassName,
}: {
	className?: string;
	iconClassName?: string;
	labelClassName?: string;
}) {
	const { t } = useLingui();
	const { setTheme, resolvedTheme } = useTheme();

	const toggleTheme = () => {
		const nextTheme = resolvedTheme === "light" ? "dark" : "light";
		const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
		setTheme(nextTheme === systemTheme ? "system" : nextTheme);
	};

	const isLight = resolvedTheme === "light";
	const label = isLight ? t`Light theme. Switch to dark` : t`Dark theme. Switch to light`;
	const Icon = isLight ? Sun : Moon;

	return (
		<Button
			variant="ghost"
			className={className}
			aria-label={label}
			title={label}
			onClick={toggleTheme}
		>
			<Icon className={iconClassName} aria-hidden="true" />
			<span className={labelClassName}>{isLight ? t`Light` : t`Dark`}</span>
		</Button>
	);
}
