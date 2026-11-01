import { Input, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Cube } from "@phosphor-icons/react";
import * as React from "react";

import type { BlockType } from "../lib/api/schema.js";
import { cn } from "../lib/utils.js";
import { resolveNavIcon } from "./admin-navigation-icons.js";

export function BlockTypeIcon({ name, className }: { name?: string; className?: string }) {
	const Icon = resolveNavIcon(name, Cube);
	return (
		<React.Suspense fallback={<Cube className={className} aria-hidden="true" />}>
			<Icon className={className} aria-hidden="true" />
		</React.Suspense>
	);
}

export interface BlockTypePickerProps {
	open: boolean;
	anchor: Element | null;
	side: "top" | "bottom";
	/** Gets focus back when the picker is dismissed with Escape. */
	invoker: HTMLElement | null;
	blockTypes: readonly BlockType[];
	onPick: (blockType: BlockType) => void;
	onClose: () => void;
}

export function BlockTypePicker({
	open,
	anchor,
	side,
	invoker,
	blockTypes,
	onPick,
	onClose,
}: BlockTypePickerProps) {
	const { t } = useLingui();
	const restoreFocusRef = React.useRef(false);

	return (
		<Popover
			open={open}
			onOpenChange={(next, details) => {
				if (next) return;
				restoreFocusRef.current = details.reason === "escape-key";
				onClose();
			}}
			onOpenChangeComplete={(isOpen) => {
				if (isOpen || !restoreFocusRef.current) return;
				restoreFocusRef.current = false;
				if (invoker?.isConnected) invoker.focus();
			}}
		>
			<Popover.Content
				anchor={anchor}
				side={side}
				align="start"
				sideOffset={4}
				className="max-h-[min(26rem,var(--available-height))] w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0 *:data-side:hidden"
			>
				<Popover.Title className="sr-only">{t`Add block`}</Popover.Title>
				<PickerList blockTypes={blockTypes} onPick={onPick} />
			</Popover.Content>
		</Popover>
	);
}

function PickerList({ blockTypes, onPick }: Pick<BlockTypePickerProps, "blockTypes" | "onPick">) {
	const { t } = useLingui();
	const id = React.useId();
	const [query, setQuery] = React.useState("");
	const [active, setActive] = React.useState(0);

	const needle = query.trim().toLocaleLowerCase();
	const groups = new Map<string, BlockType[]>();
	for (const blockType of blockTypes) {
		const matches =
			!needle ||
			blockType.label.toLocaleLowerCase().includes(needle) ||
			blockType.slug.toLocaleLowerCase().includes(needle) ||
			blockType.category?.toLocaleLowerCase().includes(needle);
		if (!matches) continue;
		const category = blockType.category || t`Other`;
		groups.set(category, [...(groups.get(category) ?? []), blockType]);
	}
	const options = [...groups.values()].flat();
	const activeIndex = Math.min(active, options.length - 1);
	const optionId = (index: number) => `${id}-option-${index}`;

	const moveTo = (index: number) => {
		setActive(index);
		document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (options.length === 0) return;
		if (event.key === "ArrowDown") moveTo((activeIndex + 1) % options.length);
		else if (event.key === "ArrowUp") moveTo((activeIndex - 1 + options.length) % options.length);
		else if (event.key === "Enter") {
			if (event.nativeEvent.isComposing || event.keyCode === 229) return;
			onPick(options[activeIndex]!);
		} else return;
		event.preventDefault();
	};

	let optionIndex = 0;
	return (
		<div className="flex min-h-0 flex-col">
			<div className="border-b border-kumo-hairline p-2">
				<Input
					role="combobox"
					aria-label={t`Search block types`}
					aria-expanded={options.length > 0}
					aria-controls={`${id}-listbox`}
					aria-activedescendant={options.length > 0 ? optionId(activeIndex) : undefined}
					aria-autocomplete="list"
					autoComplete="off"
					placeholder={t`Search blocks`}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={handleKeyDown}
					className="w-full"
				/>
			</div>
			<div
				id={`${id}-listbox`}
				role="listbox"
				aria-label={t`Block types`}
				className={cn(
					"min-h-0 overflow-y-auto overscroll-contain p-1",
					options.length === 0 && "hidden",
				)}
			>
				{Array.from(groups, ([category, types], groupIndex) => (
					<div key={category} role="group" aria-labelledby={`${id}-group-${groupIndex}`}>
						<div
							id={`${id}-group-${groupIndex}`}
							role="presentation"
							className="px-2 pt-2 pb-1 text-xs font-medium text-kumo-subtle"
						>
							{category}
						</div>
						{types.map((blockType) => {
							const index = optionIndex++;
							return (
								// oxlint-disable-next-line click-events-have-key-events -- keyboard selection is handled on the combobox input
								<div
									key={blockType.slug}
									id={optionId(index)}
									role="option"
									aria-selected={index === activeIndex}
									className={cn(
										"flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5",
										index === activeIndex && "bg-kumo-tint",
									)}
									onMouseMove={() => {
										if (index !== activeIndex) setActive(index);
									}}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => onPick(blockType)}
								>
									<span className="grid size-10 shrink-0 place-items-center rounded-lg border border-kumo-line bg-kumo-base text-kumo-default">
										<BlockTypeIcon name={blockType.icon} className="size-5" />
									</span>
									<span className="grid min-w-0 gap-0.5">
										<span className="font-medium text-kumo-default">{blockType.label}</span>
										{blockType.description && (
											<span className="line-clamp-2 text-xs text-kumo-subtle">
												{blockType.description}
											</span>
										)}
									</span>
								</div>
							);
						})}
					</div>
				))}
			</div>
			{options.length === 0 && (
				<p className="px-3 py-6 text-center text-sm text-kumo-subtle">{t`No matching block types`}</p>
			)}
		</div>
	);
}
