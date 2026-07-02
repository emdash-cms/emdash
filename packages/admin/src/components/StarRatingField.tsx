import { useLingui } from "@lingui/react/macro";
import { Star } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils";

/** Built-in widget name that selects the star rating editor for a numeric field. */
export const BUILTIN_WIDGET_STARS = "stars";

/** Default number of stars when a field does not set `options.max`. */
export const DEFAULT_STAR_MAX = 5;

export interface StarRatingFieldProps {
	id: string;
	label: string;
	/** Stored value. Coerced to an integer in the range 0..max. */
	value: unknown;
	onChange: (value: number) => void;
	/** Highest rating, from the field's `options.max` (default 5). */
	max?: number;
	required?: boolean;
	/** When true, render compactly (used inside nested editors). */
	minimal?: boolean;
}

function clampMax(max: number | undefined): number {
	if (typeof max !== "number" || !Number.isFinite(max) || max < 1) {
		return DEFAULT_STAR_MAX;
	}
	return Math.floor(max);
}

/**
 * Star rating editor for integer/number fields. Click a star to set the value,
 * click the current value again to clear it. The stored value is a plain
 * integer (0 means unrated), so themes can read it without any widget runtime.
 *
 * Selected by setting a field's `widget` to `"stars"`; `options.max` controls
 * how many stars render.
 */
export function StarRatingField({
	id,
	label,
	value,
	onChange,
	max,
	required,
	minimal,
}: StarRatingFieldProps) {
	const { t } = useLingui();
	const starCount = clampMax(max);
	const current = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
	const [hovered, setHovered] = React.useState(0);
	const shown = hovered || current;
	const labelId = `${id}-label`;

	return (
		<div id={id}>
			{!minimal && label ? (
				<span
					id={labelId}
					className={cn("mb-1 block text-sm font-medium leading-none text-kumo-default")}
				>
					{label}
				</span>
			) : null}
			<div
				role="radiogroup"
				aria-labelledby={!minimal && label ? labelId : undefined}
				aria-label={minimal || !label ? t`Rating` : undefined}
				aria-required={required}
				className="flex items-center gap-1"
				onMouseLeave={() => setHovered(0)}
			>
				{Array.from({ length: starCount }, (_, i) => i + 1).map((n) => {
					const filled = n <= shown;
					return (
						<button
							key={n}
							type="button"
							role="radio"
							aria-checked={n === current}
							aria-label={t`${n} of ${starCount}`}
							className="cursor-pointer rounded-sm border-0 bg-transparent p-0.5 text-kumo-subtle/40 transition-colors hover:text-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-accent data-[filled=true]:text-amber-400"
							data-filled={filled}
							onClick={() => onChange(n === current ? 0 : n)}
							onMouseEnter={() => setHovered(n)}
						>
							<Star weight={filled ? "fill" : "regular"} className="h-6 w-6" />
						</button>
					);
				})}
				<span className="ms-2 text-sm text-kumo-subtle">
					{current}/{starCount}
				</span>
			</div>
		</div>
	);
}
