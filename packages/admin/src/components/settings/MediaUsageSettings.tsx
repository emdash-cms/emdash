import { Badge, Banner, Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useCurrentUser } from "../../lib/api/current-user.js";
import {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MediaUsageActivationRequestError,
	advanceMediaUsageActivation,
	fetchMediaUsageActivationStatus,
	fetchMediaUsageProgress,
	type MediaUsageActivationStatus,
	type MediaUsageProgress,
} from "../../lib/api/media-usage-activation.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

const ROLE_ADMIN = 50;

type Notice = "unconfirmed" | "version" | "validation" | "denied" | null;

export function MediaUsageSettings() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const { data: currentUser, isLoading: userLoading } = useCurrentUser();
	const isAdmin = !!currentUser && currentUser.role >= ROLE_ADMIN;
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [notice, setNotice] = React.useState<Notice>(null);
	const [pageVisible, setPageVisible] = React.useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const submittingRef = React.useRef(false);
	const focusAfterActionRef = React.useRef(false);
	const stateHeadingRef = React.useRef<HTMLHeadingElement>(null);
	const wasHiddenRef = React.useRef(false);

	const activationQuery = useQuery({
		queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY,
		queryFn: fetchMediaUsageActivationStatus,
		enabled: isAdmin,
		retry: false,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchInterval: (query) => {
			const activation = query.state.data;
			return pageVisible &&
				query.state.status !== "error" &&
				activation?.state === "activating" &&
				activation.lastErrorCode === null
				? 2_000
				: false;
		},
		refetchIntervalInBackground: false,
	});
	const progressQuery = useQuery({
		queryKey: ["media-usage-progress"],
		queryFn: fetchMediaUsageProgress,
		enabled: isAdmin && activationQuery.data?.state === "active" && !activationQuery.isError,
		retry: false,
		refetchInterval: (query) =>
			pageVisible && query.state.status !== "error" && query.state.data?.status === "indexing"
				? 2_000
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

	const closeDialog = React.useCallback(() => {
		setDialogOpen(false);
	}, []);
	const refreshStatus = React.useCallback(
		async (uncertain = false) => {
			if (submittingRef.current) return;
			if (uncertain) {
				setNotice("unconfirmed");
				closeDialog();
			}
			const result = await activationQuery.refetch({ cancelRefetch: false });
			if (!result.isSuccess) return;
			setNotice((current) => (current === "validation" || current === "version" ? current : null));
		},
		[activationQuery, closeDialog],
	);

	React.useEffect(() => {
		if (!isAdmin) return;
		const visibilityChanged = () => {
			const visible = document.visibilityState !== "hidden";
			setPageVisible(visible);
			if (!visible) {
				wasHiddenRef.current = true;
				closeDialog();
				return;
			}
			if (!wasHiddenRef.current) return;
			wasHiddenRef.current = false;
			const activation = activationQuery.data;
			if (
				activation?.state === "activating" &&
				activation.lastErrorCode === null &&
				!activationQuery.isError
			) {
				void activationQuery.refetch({ cancelRefetch: false });
			} else if (
				activation?.state === "active" &&
				progressQuery.data?.status === "indexing" &&
				!progressQuery.isError
			) {
				void progressQuery.refetch({ cancelRefetch: false });
			}
		};
		document.addEventListener("visibilitychange", visibilityChanged);
		return () => {
			document.removeEventListener("visibilitychange", visibilityChanged);
		};
	}, [activationQuery, closeDialog, isAdmin, progressQuery]);

	const advanceMutation = useMutation({
		mutationFn: async () => {
			await queryClient.cancelQueries({ queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY });
			return advanceMediaUsageActivation({ writersDrained: true, maintenanceReady: true });
		},
		retry: false,
		onSuccess: (result) => {
			queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, result.activation);
			setNotice(null);
			closeDialog();
		},
		onError: (caught) => {
			submittingRef.current = false;
			void handleAdvanceError(caught);
		},
		onSettled: () => {
			submittingRef.current = false;
		},
	});

	const handleAdvanceError = async (caught: unknown) => {
		const error =
			caught instanceof MediaUsageActivationRequestError
				? caught
				: new MediaUsageActivationRequestError("unknown", null);
		closeDialog();
		if (error.kind === "denied") return setNotice("denied");
		if (error.kind === "version_mismatch") return setNotice("version");
		if (error.kind === "validation") return setNotice("validation");
		await refreshStatus(true);
	};

	const activation = activationQuery.data;
	const active = activation?.state === "active";
	React.useEffect(() => {
		const heading = stateHeadingRef.current;
		if (
			!focusAfterActionRef.current ||
			!pageVisible ||
			dialogOpen ||
			advanceMutation.isPending ||
			!activation ||
			!heading
		)
			return;
		focusAfterActionRef.current = false;
		heading.focus();
	}, [activation, advanceMutation.isPending, dialogOpen, pageVisible]);

	const title = t`Media Usage`;
	const description = t`Track where media is used across your content.`;
	if (userLoading) return <LoadingPage title={title} description={description} />;
	if (!isAdmin || isActivationError(activationQuery.error, "denied") || notice === "denied") {
		return (
			<MessagePage
				title={t`Access denied`}
				description={t`You need Admin permissions to manage Media Usage.`}
				message={t`Ask an administrator to complete this setup.`}
			/>
		);
	}
	if (isActivationError(activationQuery.error, "version_mismatch") || notice === "version") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Keep editing paused and deploy a compatible EmDash version before continuing.`}
			/>
		);
	}
	if (notice === "validation") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Reload after updating EmDash before trying again.`}
			/>
		);
	}
	if (notice === "unconfirmed") {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Activation cannot be confirmed. Keep editing paused and refresh the status.`}
				action={
					<Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>
						{t`Refresh status`}
					</Button>
				}
			/>
		);
	}
	const activationReadError = activationQuery.isError || activationQuery.isRefetchError;
	if (activationReadError && !activation) {
		return (
			<MessagePage
				title={title}
				description={description}
				message={t`Couldn’t load Media Usage settings.`}
				action={
					<Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>
						{t`Try again`}
					</Button>
				}
			/>
		);
	}
	if (activationQuery.isPending || !activation) {
		return <LoadingPage title={title} description={description} />;
	}

	const storedFailure = activation.state === "activating" && activation.lastErrorCode !== null;
	const canMutate = !activationReadError && (activation.state === "expanded" || storedFailure);
	const submit = () => {
		if (submittingRef.current) return;
		submittingRef.current = true;
		focusAfterActionRef.current = true;
		advanceMutation.mutate();
	};

	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection
				title={t`Automatic indexing`}
				actions={
					activationReadError ? (
						<Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>
							{t`Try again`}
						</Button>
					) : active && progressQuery.isError ? (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => void progressQuery.refetch({ cancelRefetch: false })}
						>
							{t`Try again`}
						</Button>
					) : undefined
				}
			>
				<StatusRow
					activation={activation}
					progress={progressQuery.isError ? undefined : progressQuery.data}
					progressError={progressQuery.isError}
					activationError={activationReadError}
					stateHeadingRef={stateHeadingRef}
				/>
				{canMutate ? (
					<SettingRow className="flex justify-end">
						<Button
							className="w-full sm:w-auto"
							disabled={advanceMutation.isPending}
							icon={advanceMutation.isPending ? <Loader size="sm" /> : undefined}
							onClick={() => setDialogOpen(true)}
						>
							{storedFailure ? t`Retry setup` : t`Enable Media Usage`}
						</Button>
					</SettingRow>
				) : null}
			</SettingsSection>

			<ConfirmationDialog
				open={dialogOpen}
				retry={storedFailure}
				pending={advanceMutation.isPending}
				onOpenChange={setDialogOpen}
				onConfirm={submit}
			/>
		</SettingsFrame>
	);
}

function StatusRow({
	activation,
	progress,
	progressError,
	activationError,
	stateHeadingRef,
}: {
	activation: MediaUsageActivationStatus;
	progress: MediaUsageProgress | undefined;
	progressError: boolean;
	activationError: boolean;
	stateHeadingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
	const { t } = useLingui();
	const active = activation.state === "active";
	const settingUp = activation.state === "activating";
	const storedFailure = activation.state === "activating" && activation.lastErrorCode !== null;
	const starting =
		active &&
		!progressError &&
		(!progress || (progress.status === "indexing" && progress.indexingStarted === false));
	let heading = t`Automatic indexing is off`;
	let detail = t`Enable Media Usage to index existing content and keep references up to date.`;
	let badge = t`Off`;
	let variant: "neutral" | "warning" | "success" | "error" = "neutral";
	if (settingUp) {
		heading = storedFailure ? t`Needs attention` : t`Setting up`;
		detail = storedFailure
			? t`Keep editing paused, fix the server issue, then retry setup.`
			: t`Capture is being prepared. Keep editing paused until setup is complete.`;
		badge = storedFailure ? t`Needs attention` : t`Setting up`;
		variant = storedFailure ? "error" : "warning";
	}
	if (active) {
		heading = progressError
			? t`Needs attention`
			: starting
				? t`Starting indexing`
				: progress?.finalizing
					? t`Finishing setup`
					: progress?.status === "ready"
						? t`Ready`
						: progress?.status === "needs_attention"
							? t`Needs attention`
							: t`Indexing existing content`;
		detail = progressError
			? t`New changes are still tracked automatically.`
			: starting
				? t`Background indexing is starting.`
				: progress?.finalizing
					? t`All existing content is indexed. Checking that Media Usage is ready.`
					: progress
						? t`Content types ready: ${progress.readyCollections} of ${progress.totalCollections}`
						: t`Background indexing is starting.`;
		badge = progressError ? t`Needs attention` : heading;
		variant = progressError
			? "error"
			: progress?.status === "ready"
				? "success"
				: progress?.status === "needs_attention"
					? "error"
					: "warning";
	}
	if (activationError) {
		const lastState =
			activation.state === "activating"
				? t`Setting up`
				: activation.state === "active"
					? t`Active`
					: t`Off`;
		heading = t`Needs attention`;
		detail = t`The last confirmed state was ${lastState}. Refresh status before continuing.`;
		badge = t`Needs attention`;
		variant = "error";
	}
	const progressing =
		!activationError &&
		((settingUp && !storedFailure) ||
			(active && !progressError && (!progress || progress.status === "indexing")));
	return (
		<SettingRow>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0" role={storedFailure ? "alert" : undefined}>
					<div className="flex items-center gap-2">
						{progressing ? <Loader size="sm" /> : null}
						<h3
							ref={stateHeadingRef}
							tabIndex={-1}
							aria-live={storedFailure ? "off" : "polite"}
							aria-atomic="true"
							className="text-sm font-medium leading-5"
						>
							{heading}
						</h3>
					</div>
					<p className="mt-0.5 max-w-2xl text-sm leading-5 text-kumo-subtle">{detail}</p>
				</div>
				<Badge variant={variant} className="shrink-0">
					{badge}
				</Badge>
			</div>
		</SettingRow>
	);
}

function ConfirmationDialog({
	open,
	retry,
	pending,
	onOpenChange,
	onConfirm,
}: {
	open: boolean;
	retry: boolean;
	pending: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
}) {
	const { t } = useLingui();
	return (
		<ConfirmDialog
			open={open}
			onClose={() => onOpenChange(false)}
			title={retry ? t`Retry setup?` : t`Turn on Media Usage?`}
			description={
				retry
					? t`EmDash will continue setup and resume scanning existing content. Editing may briefly pause.`
					: t`EmDash will scan existing content to show where media is used. Setup may briefly pause editing. Once enabled, it can’t be turned off.`
			}
			confirmLabel={retry ? t`Retry setup` : t`Turn on`}
			pendingLabel={retry ? t`Retrying…` : t`Turning on…`}
			variant="primary"
			compact
			isPending={pending}
			error={null}
			onConfirm={onConfirm}
		/>
	);
}

function LoadingPage({ title, description }: { title: string; description: string }) {
	const { t } = useLingui();
	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection title={t`Automatic indexing`}>
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading Media Usage settings…`}
					</div>
				</SettingRow>
			</SettingsSection>
		</SettingsFrame>
	);
}

function MessagePage({
	title,
	description,
	message,
	action,
}: {
	title: string;
	description: string;
	message: string;
	action?: React.ReactNode;
}) {
	const { t } = useLingui();
	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection title={t`Automatic indexing`}>
				<SettingRow>
					<Banner variant="error" role="alert" title={message} action={action} />
				</SettingRow>
			</SettingsSection>
		</SettingsFrame>
	);
}

function isActivationError(error: unknown, kind: MediaUsageActivationRequestError["kind"]) {
	return error instanceof MediaUsageActivationRequestError && error.kind === kind;
}
