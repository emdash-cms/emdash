import { Check } from "@phosphor-icons/react";

import type { PricingPlan, PricingTableBlock } from "../types.js";

function PricingCard({ plan }: { plan: PricingPlan }) {
	const isHighlighted = plan.highlighted ?? false;

	return (
		<div
			className={`flex flex-col rounded-lg border p-6 ${
				isHighlighted
					? "border-kumo-brand bg-kumo-brand/5 shadow-lg ring-2 ring-kumo-brand"
					: "border-kumo-line bg-kumo-base"
			}`}
		>
			<div className="mb-4">
				<h3 className="text-lg font-semibold text-kumo-default">{plan.name}</h3>
				{plan.description && <p className="mt-1 text-sm text-kumo-subtle">{plan.description}</p>}
			</div>
			<div className="mb-6">
				<span className="text-3xl font-bold text-kumo-default">{plan.price}</span>
				{plan.period && <span className="text-sm text-kumo-subtle">/{plan.period}</span>}
			</div>
			<ul className="mb-6 flex-1 space-y-2">
				{plan.features.map((feature, index) => (
					<li key={index} className="flex items-start gap-2 text-sm text-kumo-default">
						<Check size={16} className="mt-0.5 shrink-0 text-kumo-brand" weight="bold" />
						{feature}
					</li>
				))}
			</ul>
			{plan.ctaLabel && (
				<a
					href={plan.ctaHref || "#"}
					className={`inline-flex w-full justify-center rounded-md px-4 py-2 text-sm font-medium ${
						isHighlighted
							? "bg-kumo-brand text-white hover:bg-kumo-brand/90"
							: "bg-kumo-line text-kumo-default hover:bg-kumo-line/80"
					}`}
				>
					{plan.ctaLabel}
				</a>
			)}
		</div>
	);
}

export function PricingTableBlockComponent({ block }: { block: PricingTableBlock }) {
	return (
		<section className="space-y-6">
			{(block.title || block.description) && (
				<div className="text-center">
					{block.title && (
						<h2 className="text-2xl font-semibold text-kumo-default">{block.title}</h2>
					)}
					{block.description && (
						<p className="mt-2 text-sm leading-6 text-kumo-subtle">{block.description}</p>
					)}
				</div>
			)}
			<div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
				{block.plans.map((plan, index) => (
					<PricingCard key={`${plan.name}-${index}`} plan={plan} />
				))}
			</div>
		</section>
	);
}
