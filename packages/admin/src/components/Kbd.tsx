import type * as React from "react";

export function Kbd({ children }: { children: React.ReactNode }) {
	return (
		<kbd
			dir="ltr"
			className="inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded border border-kumo-hairline bg-kumo-base px-1 font-sans text-xs leading-none text-kumo-default"
		>
			{children}
		</kbd>
	);
}
