/**
 * PasskeyList - Displays a list of passkeys with actions
 */

import * as React from "react";

import type { PasskeyInfo } from "../../lib/api";
import { PasskeyItem } from "./PasskeyItem";

export interface PasskeyListProps {
	passkeys: PasskeyInfo[];
	onRename: (id: string, name: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	isDeleting?: boolean;
	isRenaming?: boolean;
}

export function PasskeyList({
	passkeys,
	onRename,
	onDelete,
	isDeleting,
	isRenaming,
}: PasskeyListProps) {
	return (
		<ul className="space-y-3">
			{passkeys.map((passkey) => (
				<PasskeyItem
					key={passkey.id}
					passkey={passkey}
					canDelete={passkeys.length > 1}
					onRename={onRename}
					onDelete={onDelete}
					isDeleting={isDeleting}
					isRenaming={isRenaming}
				/>
			))}
		</ul>
	);
}
