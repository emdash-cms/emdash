export type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

export const THEME_STORAGE_KEY = "emdash-theme";

export const THEME_COLORS: Record<ResolvedTheme, string> = {
	light: "#f9f9f9",
	dark: "#0a0a0a",
};

export function parseThemePreference(value: unknown): ThemePreference {
	return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
	preference: ThemePreference,
	systemPrefersDark: boolean,
): ResolvedTheme {
	if (preference !== "system") return preference;
	return systemPrefersDark ? "dark" : "light";
}

/** The value to persist for a preference; `null` means remove the stored value. */
export function storedThemeValue(preference: ThemePreference): ResolvedTheme | null {
	return preference === "system" ? null : preference;
}
