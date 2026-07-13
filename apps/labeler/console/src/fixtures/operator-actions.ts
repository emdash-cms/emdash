import type { OperatorAction } from "../api/types.js";

/**
 * Empty until the `operator_actions` audit table ships (plan W9.2) —
 * the audit log route renders its empty state from this rather than
 * fabricating action history that doesn't correspond to any real schema.
 */
export const FIXTURE_OPERATOR_ACTIONS: readonly OperatorAction[] = [];
