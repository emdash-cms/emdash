import { Button, DropdownMenu } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	CaretDown,
	TextH,
	TextHFive,
	TextHFour,
	TextHOne,
	TextHSix,
	TextHThree,
	TextHTwo,
	type Icon,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils.js";

/**
 * TipTap's heading-dropdown-menu API adapted to EmDash's Kumo primitives.
 * Source pattern: `npx @tiptap/cli add heading-dropdown-menu`.
 */

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

const DEFAULT_LEVELS: readonly HeadingLevel[] = [1, 2, 3, 4, 5, 6];

const HEADING_LABELS: Record<HeadingLevel, MessageDescriptor> = {
	1: msg`Heading 1`,
	2: msg`Heading 2`,
	3: msg`Heading 3`,
	4: msg`Heading 4`,
	5: msg`Heading 5`,
	6: msg`Heading 6`,
};

const HEADING_ICONS: Record<HeadingLevel, Icon> = {
	1: TextHOne,
	2: TextHTwo,
	3: TextHThree,
	4: TextHFour,
	5: TextHFive,
	6: TextHSix,
};

export function getActiveHeadingLevel(
	editor: Editor | null,
	levels: readonly HeadingLevel[] = DEFAULT_LEVELS,
): HeadingLevel | undefined {
	if (!editor || !editor.isEditable) return undefined;
	return levels.find((level) => editor.isActive("heading", { level }));
}

function canToggleHeading(editor: Editor | null, levels: readonly HeadingLevel[]): boolean {
	if (!editor || !editor.isEditable || !editor.schema.nodes.heading) return false;
	return levels.some(
		(level) => editor.can().setNode("heading", { level }) || editor.can().clearNodes(),
	);
}

function toggleHeading(editor: Editor | null, level: HeadingLevel): boolean {
	if (!editor || !canToggleHeading(editor, [level])) return false;
	return editor.chain().focus().toggleHeading({ level }).run();
}

export interface UseHeadingDropdownMenuConfig {
	editor?: Editor | null;
	levels?: readonly HeadingLevel[];
	hideWhenUnavailable?: boolean;
}

export function useHeadingDropdownMenu(config: UseHeadingDropdownMenuConfig = {}) {
	const { editor = null, levels = DEFAULT_LEVELS, hideWhenUnavailable = false } = config;

	const state = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => {
			const activeLevel = getActiveHeadingLevel(currentEditor, levels);
			const canToggle = canToggleHeading(currentEditor, levels);
			return {
				activeLevel,
				isActive: activeLevel !== undefined,
				canToggle,
				isVisible: !hideWhenUnavailable || canToggle,
			};
		},
	});

	const activeLevel = state?.activeLevel;

	return {
		isVisible: state?.isVisible ?? !hideWhenUnavailable,
		activeLevel,
		isActive: state?.isActive ?? false,
		canToggle: state?.canToggle ?? false,
		levels,
		Icon: activeLevel ? HEADING_ICONS[activeLevel] : TextH,
	};
}

export interface HeadingDropdownMenuProps extends UseHeadingDropdownMenuConfig {
	className?: string;
	onOpenChange?: (isOpen: boolean) => void;
}

export const HeadingDropdownMenu = React.forwardRef<HTMLButtonElement, HeadingDropdownMenuProps>(
	function HeadingDropdownMenu(
		{
			editor = null,
			levels = DEFAULT_LEVELS,
			hideWhenUnavailable = false,
			className,
			onOpenChange,
		},
		ref,
	) {
		const { t } = useLingui();
		const [open, setOpen] = React.useState(false);
		const { isVisible, activeLevel, isActive, canToggle, Icon } = useHeadingDropdownMenu({
			editor,
			levels,
			hideWhenUnavailable,
		});

		const handleOpenChange = React.useCallback(
			(nextOpen: boolean) => {
				if (nextOpen && !canToggle) return;
				setOpen(nextOpen);
				onOpenChange?.(nextOpen);
			},
			[canToggle, onOpenChange],
		);

		if (!isVisible) return null;

		return (
			<DropdownMenu open={open} onOpenChange={handleOpenChange}>
				<DropdownMenu.Trigger
					render={
						<Button
							ref={ref}
							type="button"
							variant="ghost"
							className={cn(
								"h-8 min-w-11 flex-none gap-0.5 px-2",
								isActive && "bg-kumo-tint text-kumo-default",
								className,
							)}
							disabled={!canToggle}
							onMouseDown={(event) => event.preventDefault()}
							aria-label={t`Headings`}
							aria-haspopup="menu"
							aria-expanded={open}
						>
							<Icon className="h-4 w-4" aria-hidden="true" />
							<CaretDown className="h-3 w-3" aria-hidden="true" />
						</Button>
					}
				/>
				<DropdownMenu.Content align="start" className="min-w-44">
					{levels.map((level) => {
						const HeadingIcon = HEADING_ICONS[level];
						return (
							<DropdownMenu.Item
								key={level}
								icon={HeadingIcon}
								selected={activeLevel === level}
								data-emdash-heading-item
								onClick={() => toggleHeading(editor, level)}
							>
								{t(HEADING_LABELS[level])}
							</DropdownMenu.Item>
						);
					})}
				</DropdownMenu.Content>
			</DropdownMenu>
		);
	},
);
