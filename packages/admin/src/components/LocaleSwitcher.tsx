/**
 * Locale switcher component for i18n-enabled sites.
 *
 * Used in both the content list (to filter by locale) and the content editor
 * (to switch between locale versions of a content item).
 *
 * Only renders when i18n is configured (manifest.i18n is present).
 */

import { useLingui } from "@lingui/react/macro";
import { GlobeSimple } from "@phosphor-icons/react";
import React from "react";

import { cn } from "../lib/utils.js";
import { getLocaleLabel } from "../locales/config.js";

interface LocaleSwitcherProps {
	locales: string[];
	defaultLocale: string;
	value: string;
	onChange: (locale: string) => void;
	/** Show "All locales" option (for list filtering) */
	showAll?: boolean;
	className?: string;
	/** Size variant */
	size?: "sm" | "md";
}

export function LocaleSwitcher({
	locales,
	defaultLocale,
	value,
	onChange,
	showAll = false,
	className,
	size = "md",
}: LocaleSwitcherProps) {
	const { t } = useLingui();
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			<GlobeSimple
				className={cn("text-kumo-subtle shrink-0", size === "sm" ? "size-3.5" : "size-4")}
				weight="bold"
			/>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-label={t`Locale`}
				className={cn(
					"rounded-md border bg-transparent font-medium transition-colors",
					"focus:ring-kumo-ring focus:outline-none focus:ring-2 focus:ring-offset-1",
					"hover:bg-kumo-tint/50 cursor-pointer",
					size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm",
				)}
			>
				{showAll && <option value="">{t`All locales`}</option>}
				{locales.map((locale) => (
					<option key={locale} value={locale}>
						{getLocaleLabel(locale)}
						{locale === defaultLocale ? t` (default)` : ""}
					</option>
				))}
			</select>
		</div>
	);
}

/**
 * Compact locale badges showing which translations exist for a content item.
 * Renders as a row of small locale codes, with existing translations highlighted.
 */
export function LocaleBadges({
	locales,
	existingLocales,
	onLocaleClick,
}: {
	locales: string[];
	existingLocales: string[];
	onLocaleClick?: (locale: string) => void;
}) {
	const { t } = useLingui();
	const existingSet = new Set(existingLocales);

	return (
		<div className="flex items-center gap-0.5">
			{locales.map((locale) => {
				const exists = existingSet.has(locale);
				const label = getLocaleLabel(locale);
				return (
					<button
						key={locale}
						type="button"
						onClick={() => onLocaleClick?.(locale)}
						disabled={!onLocaleClick}
						title={exists ? t`${label} \u2014 view translation` : t`${label} \u2014 no translation`}
						className={cn(
							"rounded px-1 py-0.5 text-[10px] font-semibold uppercase leading-none transition-colors",
							exists
								? "bg-kumo-brand/10 text-kumo-brand hover:bg-kumo-brand/20"
								: "bg-kumo-tint text-kumo-subtle/50",
							onLocaleClick && exists && "cursor-pointer",
							(!onLocaleClick || !exists) && "cursor-default",
						)}
					>
						{locale}
					</button>
				);
			})}
		</div>
	);
}

/**
 * Hook to get i18n config from the manifest query.
 * Returns null if i18n is not configured.
 */
export function useI18nConfig(
	manifest: { i18n?: { defaultLocale: string; locales: string[] } } | undefined,
) {
	return React.useMemo(() => {
		if (!manifest?.i18n) return null;
		return manifest.i18n;
	}, [manifest?.i18n]);
}
