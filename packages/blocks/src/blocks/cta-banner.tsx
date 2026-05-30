import type { CtaBannerBlock } from "../types.js";

const variantStyles: Record<"default" | "dark" | "brand", string> = {
	default: "bg-kumo-base border border-kumo-line",
	dark: "bg-kumo-default text-white",
	brand: "bg-kumo-brand text-white",
};

const headingStyles: Record<"default" | "dark" | "brand", string> = {
	default: "text-kumo-default",
	dark: "text-white",
	brand: "text-white",
};

const textStyles: Record<"default" | "dark" | "brand", string> = {
	default: "text-kumo-subtle",
	dark: "text-white/80",
	brand: "text-white/80",
};

const primaryButtonStyles: Record<"default" | "dark" | "brand", string> = {
	default: "bg-kumo-brand text-white hover:bg-kumo-brand/90",
	dark: "bg-white text-kumo-default hover:bg-white/90",
	brand: "bg-white text-kumo-brand hover:bg-white/90",
};

const secondaryButtonStyles: Record<"default" | "dark" | "brand", string> = {
	default: "border border-kumo-line text-kumo-default hover:bg-kumo-line/50",
	dark: "border border-white/30 text-white hover:bg-white/10",
	brand: "border border-white/30 text-white hover:bg-white/10",
};

export function CtaBannerBlockComponent({ block }: { block: CtaBannerBlock }) {
	const variant = block.variant ?? "default";

	return (
		<div className={`rounded-lg p-8 ${variantStyles[variant]}`}>
			<div className="mx-auto max-w-3xl text-center">
				<h2 className={`text-2xl font-semibold ${headingStyles[variant]}`}>{block.title}</h2>
				{block.description && (
					<p className={`mt-2 text-sm leading-6 ${textStyles[variant]}`}>{block.description}</p>
				)}
				<div className="mt-6 flex flex-wrap items-center justify-center gap-4">
					<a
						href={block.primaryAction.href}
						className={`inline-flex rounded-md px-6 py-2.5 text-sm font-medium ${primaryButtonStyles[variant]}`}
					>
						{block.primaryAction.label}
					</a>
					{block.secondaryAction && (
						<a
							href={block.secondaryAction.href}
							className={`inline-flex rounded-md px-6 py-2.5 text-sm font-medium ${secondaryButtonStyles[variant]}`}
						>
							{block.secondaryAction.label}
						</a>
					)}
				</div>
			</div>
		</div>
	);
}
