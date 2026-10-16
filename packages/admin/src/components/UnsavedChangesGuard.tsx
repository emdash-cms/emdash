import { useLingui } from "@lingui/react/macro";
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router";

import { ConfirmDialog } from "./ConfirmDialog.js";

const leavesPage: ShouldBlockFn = ({ current, next }) => current.pathname !== next.pathname;

/**
 * While `when` is true, asks before leaving the page: a link to another page
 * opens a dialog, and reloading or closing the tab shows the browser's prompt.
 * A navigation the app starts after a save must pass `ignoreBlocker`.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
	const { t } = useLingui();
	const blocker = useBlocker({
		shouldBlockFn: leavesPage,
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
