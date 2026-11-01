import { useLingui } from "@lingui/react/macro";
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router";
import * as React from "react";

import { ConfirmDialog } from "./ConfirmDialog.js";

/**
 * While `when` is true, asks before leaving the page: a link to another page
 * opens a dialog, and reloading or closing the tab shows the browser's prompt.
 * A link first calls `saveBeforeLeaving` and leaves without asking when it
 * returns true. A navigation the app starts after a save or a delete must
 * pass `ignoreBlocker`.
 */
export function UnsavedChangesGuard({
	when,
	saveBeforeLeaving,
}: {
	when: boolean;
	saveBeforeLeaving?: () => boolean;
}) {
	const { t } = useLingui();
	const shouldBlockFn = React.useCallback<ShouldBlockFn>(
		({ current, next }) => current.pathname !== next.pathname && !saveBeforeLeaving?.(),
		[saveBeforeLeaving],
	);
	const blocker = useBlocker({
		shouldBlockFn,
		disabled: !when,
		withResolver: true,
	});

	return (
		<ConfirmDialog
			open={blocker.status === "blocked"}
			onClose={() => blocker.reset?.()}
			title={t`Leave without saving?`}
			description={t`Your unsaved changes will be lost.`}
			confirmLabel={t`Leave`}
			cancelLabel={t`Stay`}
			pendingLabel={t`Leave`}
			isPending={false}
			error={null}
			onConfirm={() => blocker.proceed?.()}
		/>
	);
}
