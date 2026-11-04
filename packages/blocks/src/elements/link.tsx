import { Link, LinkButton } from "@cloudflare/kumo";

import type { LinkElement, LinkTargetResolver } from "../types.js";

export function LinkElementComponent({
	element,
	resolveTarget,
}: {
	element: LinkElement;
	resolveTarget?: LinkTargetResolver;
}) {
	const href = resolveTarget?.(element.target) ?? null;
	if (!href) return null;

	const external = element.target.kind === "external";
	if (element.appearance === "primary" || element.appearance === "secondary") {
		return (
			<LinkButton
				href={href}
				variant={element.appearance === "primary" ? "primary" : "secondary"}
				external={external}
			>
				{element.label}
			</LinkButton>
		);
	}

	return (
		<Link
			href={href}
			target={external ? "_blank" : undefined}
			rel={external ? "noopener noreferrer" : undefined}
		>
			{element.label}
			{external ? <Link.ExternalIcon aria-hidden="true" /> : null}
		</Link>
	);
}
