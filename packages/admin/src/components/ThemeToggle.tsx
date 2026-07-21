import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Sun, Moon, Monitor } from "@phosphor-icons/react";
import * as React from "react";

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

	const resolvedLabel = resolvedTheme === "light" ? t`light` : t`dark`;
	const label =
		theme === "system" ? t`System (${resolvedLabel})` : theme === "light" ? t`Light` : t`Dark`;

	return (
		<Button
			variant="ghost"
			shape="square"
			size="sm"
			aria-label={t`Toggle theme (current: ${label})`}
			onClick={cycleTheme}
			title={t`Theme: ${label}`}
		>
			{theme === "system" ? (
				<Monitor className="h-4 w-4" />
			) : theme === "light" ? (
				<Sun className="h-4 w-4" />
			) : (
				<Moon className="h-4 w-4" />
			)}
			<span className="sr-only">{t`Toggle theme (current: ${label})`}</span>
		</Button>
	);
}
