import type { Permission, TransferScope } from "@emdash-cms/auth";

export { TRANSFER_SCOPES, isTransferScope } from "@emdash-cms/auth";
export type { TransferScope } from "@emdash-cms/auth";

export type TransferAction = "export" | "analyze" | "execute";

/** Token scope a bearer-token caller needs for each transfer action. */
export const TRANSFER_ACTION_SCOPE = Object.freeze({
	export: "transfer:export",
	analyze: "transfer:analyze",
	execute: "transfer:execute",
} as const satisfies Record<TransferAction, TransferScope>);

/** RBAC permission a session caller needs for each transfer action. */
export const TRANSFER_ACTION_PERMISSION = Object.freeze({
	export: "transfer:export",
	analyze: "transfer:import",
	execute: "transfer:import",
} as const satisfies Record<TransferAction, Permission>);

/** Actions an MCP approval grant can authorize. */
export const TRANSFER_APPROVAL_ACTIONS = ["export", "import"] as const;

export type TransferApprovalAction = (typeof TRANSFER_APPROVAL_ACTIONS)[number];
