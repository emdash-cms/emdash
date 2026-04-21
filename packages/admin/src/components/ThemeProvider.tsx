import * as React from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
	theme: Theme;
	setTheme: (theme: Theme) => void;
	/** The resolved theme (always "light" or "dark") */
	resolvedTheme: "light" | "dark";
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "emdash-theme";

function getSystemTheme(): "light" | "dark" {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme(): Theme {
	if (typeof window === "undefined") return "system";
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "light" || stored === "dark" || stored === "system") {
		return stored;
	}
	return "system";
}

export interface ThemeProviderProps {
	children: React.ReactNode;
	/** Default theme if none stored. Defaults to "system" */
	defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = "system" }: ThemeProviderProps) {
	const [theme, setThemeState] = React.useState<Theme>(() => {
		const stored = getStoredTheme();
		return stored === "system" ? defaultTheme : stored;
	});

	const [resolvedTheme, setResolvedTheme] = React.useState<"light" | "dark">(() => {
		if (theme === "system") return getSystemTheme();
		return theme;
	});

	// Resolve the effective theme whenever the user preference changes
	React.useEffect(() => {
		if (theme === "system") {
			setResolvedTheme(getSystemTheme());
		} else {
			setResolvedTheme(theme);
		}
	}, [theme]);

	// Listen for OS preference changes when in system mode
	React.useEffect(() => {
		if (theme !== "system") return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = (e: MediaQueryListEvent) => {
			setResolvedTheme(e.matches ? "dark" : "light");
		};

		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, [theme]);

	// Sync DOM attributes with the resolved theme.
	// data-mode drives Tailwind dark: utilities via @custom-variant.
	// data-theme is reserved for visual identity overrides (e.g. "classic").
	// Always set data-mode explicitly — relying on its absence + color-scheme
	// does not activate Tailwind dark: utilities which require [data-mode="dark"].
	React.useEffect(() => {
		const root = document.documentElement;
		root.setAttribute("data-theme", "classic");
		root.setAttribute("data-mode", resolvedTheme);
	}, [resolvedTheme]);

	const setTheme = React.useCallback((newTheme: Theme) => {
		setThemeState(newTheme);
		localStorage.setItem(STORAGE_KEY, newTheme);
	}, []);

	const value = React.useMemo(
		() => ({ theme, setTheme, resolvedTheme }),
		[theme, setTheme, resolvedTheme],
	);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const context = React.useContext(ThemeContext);
	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
