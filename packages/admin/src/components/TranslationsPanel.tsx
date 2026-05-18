/**
 * Shared "Translations" sidebar panel. Matches the look of the translations
 * section in ContentEditor — reused across content edit, menu edit and
 * taxonomy term edit so the admin shows one consistent affordance.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { cn } from "../lib/utils.js";

interface PanelTranslation {
	id: string;
	locale: string;
}

export interface TranslationsPanelProps {
	/** Heading shown above the list (default: "Translations"). */
	title?: string;
	/** All configured locales. */
	locales: string[];
	/** Marked as "(default)" in the list. */
	defaultLocale: string;
	/** Locale of the row being edited — rendered with the "current" highlight. */
	currentLocale: string | undefined;
	/** Locale variants that already exist (may include the current locale).
	 * The panel only needs `id` + `locale`; callers may pass richer summaries. */
	translations: PanelTranslation[];
	/** Called when the user clicks "Edit" on a sibling translation. */
	onOpen?: (summary: PanelTranslation) => void;
	/** Called when the user clicks "Translate" for a missing locale. */
	onCreate?: (locale: string) => void;
	/** Locale currently being created; used to disable its button. */
	pendingLocale?: string | null;
}

export function TranslationsPanel({
	title,
	locales,
	defaultLocale,
	currentLocale,
	translations,
	onOpen,
	onCreate,
	pendingLocale,
}: TranslationsPanelProps) {
	const { t } = useLingui();
	const byLocale = React.useMemo(
		() => new Map(translations.map((tr) => [tr.locale, tr])),
		[translations],
	);

	return (
		<div>
			<h3 className="mb-4 font-semibold">{title ?? t`Translations`}</h3>
			<div className="space-y-2">
				{locales.map((locale) => {
					const translation = byLocale.get(locale);
					const isCurrent = locale === currentLocale;
					return (
						<div
							key={locale}
							className={cn(
								"flex items-center justify-between rounded-md px-3 py-2 text-sm",
								isCurrent
									? "bg-kumo-brand/10 font-medium"
									: translation
										? "hover:bg-kumo-tint/50"
										: "text-kumo-subtle",
							)}
						>
							<div className="flex items-center gap-2">
								<span className="text-xs font-semibold uppercase">{locale}</span>
								{locale === defaultLocale && (
									<span className="text-[10px] text-kumo-subtle">{t` (default)`}</span>
								)}
								{isCurrent && <span className="text-[10px] text-kumo-brand">{t`current`}</span>}
							</div>
							{isCurrent ? null : translation && onOpen ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-auto px-2 py-1 text-xs"
									onClick={() => onOpen(translation)}
								>
									{t`Edit`}
								</Button>
							) : !translation && onCreate ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-auto px-2 py-1 text-xs"
									disabled={pendingLocale === locale}
									onClick={() => onCreate(locale)}
								>
									{pendingLocale === locale ? t`Translating...` : t`Translate`}
								</Button>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
