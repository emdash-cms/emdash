import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Sun, Moon, Monitor } from "@phosphor-icons/react";

import { useTheme } from "./ThemeProvider";

/**
 * Theme toggle button that cycles through: system -> light -> dark
 */
export function ThemeToggle() {
	const { t } = useLingui();
	const { theme, setTheme, resolvedTheme } = useTheme();

	const cycleTheme = () => {
		const order: ["system", "light", "dark"] = ["system", "light", "dark"];
		const currentIndex = order.indexOf(theme);
		const nextIndex = (currentIndex + 1) % order.length;
		setTheme(order[nextIndex]!);
	};

	const label =
		theme === "system" ? t`System (${resolvedTheme})` : theme === "light" ? t`Light` : t`Dark`;

	return (
		<Button
			variant="ghost"
			shape="square"
			aria-label={t`Toggle theme (current: ${label})`}
			onClick={cycleTheme}
			title={t`Theme: ${label}`}
		>
			{theme === "system" ? (
				<Monitor className="h-5 w-5" />
			) : theme === "light" ? (
				<Sun className="h-5 w-5" />
			) : (
				<Moon className="h-5 w-5" />
			)}
			<span className="sr-only">{t`Toggle theme (current: ${label})`}</span>
		</Button>
	);
}
