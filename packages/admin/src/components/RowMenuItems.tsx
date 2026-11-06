import { DropdownMenu } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowLineDown,
	ArrowLineUp,
	ArrowUp,
	Copy,
	RowsPlusBottom,
	RowsPlusTop,
	Trash,
} from "@phosphor-icons/react";

const MENU_ICON = "size-4";

/** The actions in a block's or a list item's menu, in the order both menus show them. */
export function RowMenuItems({
	index,
	count,
	add,
	duplicate,
	deleteDisabled = false,
	onMove,
	onDelete,
}: {
	index: number;
	count: number;
	/** Adds a row above or below this one, under the labels `above` and `below`. */
	add?: {
		above: string;
		below: string;
		disabled: boolean;
		onSelect: (side: "above" | "below") => void;
	};
	duplicate?: { disabled: boolean; onSelect: () => void };
	deleteDisabled?: boolean;
	onMove: (to: number, slide?: boolean) => void;
	onDelete: () => void;
}) {
	const { t } = useLingui();
	return (
		<>
			{add && (
				<>
					<DropdownMenu.Item
						icon={<RowsPlusTop className={MENU_ICON} aria-hidden="true" />}
						disabled={add.disabled}
						onClick={() => add.onSelect("above")}
					>
						{add.above}
					</DropdownMenu.Item>
					<DropdownMenu.Item
						icon={<RowsPlusBottom className={MENU_ICON} aria-hidden="true" />}
						disabled={add.disabled}
						onClick={() => add.onSelect("below")}
					>
						{add.below}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
				</>
			)}
			{duplicate && (
				<DropdownMenu.Item
					icon={<Copy className={MENU_ICON} aria-hidden="true" />}
					disabled={duplicate.disabled}
					onClick={duplicate.onSelect}
				>
					{t`Duplicate`}
				</DropdownMenu.Item>
			)}
			<DropdownMenu.Item
				icon={<ArrowUp className={MENU_ICON} aria-hidden="true" />}
				disabled={index === 0}
				onClick={() => onMove(index - 1, true)}
			>
				{t`Move up`}
			</DropdownMenu.Item>
			<DropdownMenu.Item
				icon={<ArrowDown className={MENU_ICON} aria-hidden="true" />}
				disabled={index === count - 1}
				onClick={() => onMove(index + 1, true)}
			>
				{t`Move down`}
			</DropdownMenu.Item>
			<DropdownMenu.Item
				icon={<ArrowLineUp className={MENU_ICON} aria-hidden="true" />}
				disabled={index === 0}
				onClick={() => onMove(0, true)}
			>
				{t`Move to top`}
			</DropdownMenu.Item>
			<DropdownMenu.Item
				icon={<ArrowLineDown className={MENU_ICON} aria-hidden="true" />}
				disabled={index === count - 1}
				onClick={() => onMove(count - 1, true)}
			>
				{t`Move to bottom`}
			</DropdownMenu.Item>
			<DropdownMenu.Separator />
			<DropdownMenu.Item
				variant="danger"
				icon={<Trash className={MENU_ICON} aria-hidden="true" />}
				disabled={deleteDisabled}
				onClick={onDelete}
			>
				{t`Delete`}
			</DropdownMenu.Item>
		</>
	);
}
