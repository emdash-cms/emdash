import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Sun, Moon } from "@phosphor-icons/react";

import { useTheme } from "./ThemeProvider";

export function ThemeToggle() {
	const { t } = useLingui();
	const { setTheme, resolvedTheme } = useTheme();

	const toggleTheme = () => {
		const nextTheme = resolvedTheme === "light" ? "dark" : "light";
		const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
		setTheme(nextTheme === systemTheme ? "system" : nextTheme);
	};

	const label = resolvedTheme === "light" ? t`Switch to dark` : t`Switch to light`;

	return (
		<Button
			variant="ghost"
			shape="square"
			size="sm"
			aria-label={label}
			onClick={toggleTheme}
			title={label}
		>
			{resolvedTheme === "light" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
			<span className="sr-only">{label}</span>
		</Button>
	);
}
