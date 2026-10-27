/**
 * Router-aware anchor styled as a Kumo button.
 *
 * Wraps TanStack Router's `Link` so it routes client-side, but matches the
 * Kumo `Button` API surface for `variant` / `size` / `shape` / `icon`. Use
 * this anywhere you'd reach for `<Link><Button>...</Button></Link>` (which
 * is invalid HTML — renders `<a><button>`).
 *
 * Inherits TanStack Router's typed `to` / `params` / `search` / `preload`
 * props by spreading them through to the underlying `<Link>`.
 *
 * @example
 * ```tsx
 * <RouterLinkButton to="/settings" variant="ghost" shape="square"
 *   aria-label={t`Back to settings`} icon={<ArrowPrev />} />
 *
 * <RouterLinkButton to="/posts/$id" params={{ id }} variant="primary">
 *   {t`Edit post`}
 * </RouterLinkButton>
 * ```
 *
 * For external links (or anything that needs `target="_blank"`), use Kumo's
 * `LinkButton` directly with `external`.
 */

import {
	LinkButton,
	LinkProvider,
	type LinkButtonProps,
	type LinkComponentProps,
} from "@cloudflare/kumo";
import { Link, type LinkProps } from "@tanstack/react-router";
import * as React from "react";

type ButtonStyleProps = Pick<LinkButtonProps, "variant" | "size" | "shape" | "icon">;

export type RouterLinkButtonProps = Omit<LinkProps, "children"> &
	ButtonStyleProps & {
		className?: string;
		children?: React.ReactNode;
		onClick?: React.MouseEventHandler<HTMLAnchorElement>;
	};

// Kumo's primary and destructive styles need the CSS variables and inner
// markup that only its own components render, so the button is drawn by
// `LinkButton` and only its anchor is swapped for the router's `Link`.
const RouterAnchor = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(function RouterAnchor(
	{ href: _href, ...props },
	ref,
) {
	return <Link ref={ref} {...(props as LinkProps)} />;
});

export function RouterLinkButton({
	className,
	variant = "secondary",
	size,
	shape,
	icon,
	children,
	...linkProps
}: RouterLinkButtonProps) {
	return (
		<LinkProvider component={RouterAnchor}>
			<LinkButton
				{...linkProps}
				variant={variant}
				size={size}
				shape={shape}
				icon={icon}
				className={className}
			>
				{children}
			</LinkButton>
		</LinkProvider>
	);
}
