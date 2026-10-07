/**
 * Shared building blocks for the editor's block, slash, and selection menus.
 *
 * Built on Base UI's menu primitive rather than Kumo's DropdownMenu so the
 * submenu trigger and icons use logical (RTL-safe) spacing.
 */

import { Menu } from "@cloudflare/kumo/primitives/menu";
import { Check, type Icon } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import * as React from "react";

import { cn } from "../../lib/utils.js";
import { CaretNext } from "../ArrowIcons.js";

/** The surface of the editor's floating menus and toolbars. */
export const editorSurfaceClassName =
	"rounded-[10px] bg-kumo-control shadow-lg ring ring-kumo-line";

export const editorMenuPopupClassName = cn(
	"min-w-56 max-h-[min(26rem,var(--available-height))] overflow-y-auto overscroll-contain",
	editorSurfaceClassName,
	"p-1 text-base text-kumo-default outline-none",
	"origin-(--transform-origin) transition-[scale,opacity] duration-100 ease-out",
	"data-starting-style:scale-[0.97] data-starting-style:opacity-0",
	"data-ending-style:opacity-0 data-ending-style:duration-75",
	"motion-reduce:transition-none",
);

/**
 * Tab closes an editor menu back into the editor. The menu is portalled to
 * the end of the page, so the browser would otherwise move focus past it.
 */
export function tabToEditor(editor: Editor, close: () => void) {
	return (event: React.KeyboardEvent) => {
		if (event.key !== "Tab" || editor.isDestroyed) return;
		event.preventDefault();
		close();
		editor.view.focus();
	};
}

export const editorMenuItemClassName = cn(
	"flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-start outline-none select-none",
	"data-highlighted:bg-kumo-tint data-popup-open:bg-kumo-tint",
	"data-disabled:pointer-events-none data-disabled:opacity-50",
	"pointer-coarse:h-11",
);

interface EditorMenuItemProps extends Omit<Menu.Item.Props, "className" | "children" | "label"> {
	icon?: Icon;
	label: string;
	danger?: boolean;
}

function ItemContent({
	icon: ItemIcon,
	label,
	danger,
	indicator,
}: {
	icon?: Icon;
	label: string;
	danger?: boolean;
	indicator?: React.ReactNode;
}) {
	return (
		<>
			{ItemIcon && (
				<ItemIcon
					className={cn("size-4 flex-none", !danger && "text-kumo-subtle")}
					aria-hidden="true"
				/>
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{indicator}
		</>
	);
}

export function EditorMenuItem({ icon, label, danger, ...props }: EditorMenuItemProps) {
	return (
		<Menu.Item
			{...props}
			label={label}
			className={cn(
				editorMenuItemClassName,
				danger && "text-kumo-danger data-highlighted:bg-kumo-danger/10",
			)}
		>
			<ItemContent icon={icon} label={label} danger={danger} />
		</Menu.Item>
	);
}

const checkIndicator = <Check className="size-4 flex-none" aria-hidden="true" />;

interface EditorMenuRadioItemProps extends Omit<
	Menu.RadioItem.Props,
	"className" | "children" | "label"
> {
	icon?: Icon;
	label: string;
}

/** One choice in a `Menu.RadioGroup`, checked when it is the group's value. */
export function EditorMenuRadioItem({ icon, label, ...props }: EditorMenuRadioItemProps) {
	return (
		<Menu.RadioItem closeOnClick {...props} label={label} className={editorMenuItemClassName}>
			<ItemContent
				icon={icon}
				label={label}
				indicator={<Menu.RadioItemIndicator render={checkIndicator} />}
			/>
		</Menu.RadioItem>
	);
}

interface EditorMenuCheckboxItemProps extends Omit<
	Menu.CheckboxItem.Props,
	"className" | "children" | "label"
> {
	icon?: Icon;
	label: string;
}

export function EditorMenuCheckboxItem({ icon, label, ...props }: EditorMenuCheckboxItemProps) {
	return (
		<Menu.CheckboxItem closeOnClick {...props} label={label} className={editorMenuItemClassName}>
			<ItemContent
				icon={icon}
				label={label}
				indicator={<Menu.CheckboxItemIndicator render={checkIndicator} />}
			/>
		</Menu.CheckboxItem>
	);
}

export function EditorMenuLabel({ children }: { children: React.ReactNode }) {
	return (
		<Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-xs font-medium text-kumo-subtle select-none">
			{children}
		</Menu.GroupLabel>
	);
}

export function EditorMenuSeparator() {
	return <Menu.Separator className="-mx-1 my-1 h-px bg-kumo-hairline" />;
}

export function EditorSubmenu({
	icon: TriggerIcon,
	label,
	children,
	popupClassName,
}: {
	icon?: Icon;
	label: string;
	children: React.ReactNode;
	popupClassName?: string;
}) {
	return (
		<Menu.SubmenuRoot>
			<Menu.SubmenuTrigger label={label} openOnHover delay={60} className={editorMenuItemClassName}>
				{TriggerIcon && (
					<TriggerIcon className="size-4 flex-none text-kumo-subtle" aria-hidden="true" />
				)}
				<span className="min-w-0 flex-1 truncate">{label}</span>
				<CaretNext className="size-3.5 flex-none text-kumo-subtle" aria-hidden="true" />
			</Menu.SubmenuTrigger>
			<Menu.Portal>
				<Menu.Positioner side="inline-end" align="start" sideOffset={6} alignOffset={-4}>
					<Menu.Popup className={cn(editorMenuPopupClassName, "z-[110]", popupClassName)}>
						{children}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.SubmenuRoot>
	);
}
