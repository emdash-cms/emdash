export type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

export function toggledThemePreference(
	resolvedTheme: ResolvedTheme,
	systemTheme: ResolvedTheme,
): ThemePreference {
	const nextTheme = resolvedTheme === "light" ? "dark" : "light";
	return nextTheme === systemTheme ? "system" : nextTheme;
}
