import { Badge, Banner, Button, Checkbox, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { useCurrentUser } from "../../lib/api/current-user.js";
import {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MEDIA_USAGE_PROGRESS_QUERY_KEY,
	MediaUsageActivationRequestError,
	advanceMediaUsageActivation,
	advanceMediaUsageProgress,
	fetchMediaUsageActivationStatus,
	fetchMediaUsageProgress,
	type MediaUsageActivationStatus,
	type MediaUsageProgress,
	type MediaUsageProgressAdvanceResponse,
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
	const [progress, setProgress] = React.useState<MediaUsageProgress | undefined>(() =>
		queryClient.getQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY),
	);
	const [progressRequestError, setProgressRequestError] = React.useState(false);
	const [resumeToken, setResumeToken] = React.useState(0);
	const submittingRef = React.useRef(false);
	const progressRequestRef = React.useRef<Promise<MediaUsageProgressAdvanceResponse> | null>(null);
	const mountedRef = React.useRef(true);
	const pageVisibleRef = React.useRef(pageVisible);
	const focusAfterActionRef = React.useRef(false);
	const stateHeadingRef = React.useRef<HTMLHeadingElement>(null);
	const wasHiddenRef = React.useRef(false);
	React.useEffect(() => {
		mountedRef.current = true;
		pageVisibleRef.current = document.visibilityState !== "hidden";
		return () => {
			mountedRef.current = false;
			pageVisibleRef.current = false;
		};
	}, []);

	const activationQuery = useQuery({
		queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY,
		queryFn: fetchMediaUsageActivationStatus,
		enabled: isAdmin,
		retry: false,
		refetchOnMount: "always",
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
			setResumeToken((current) => current + 1);
			setNotice((current) => (current === "validation" || current === "version" ? current : null));
		},
		[activationQuery, closeDialog],
	);
	const handleProgressAccessError = React.useCallback((caught: unknown): boolean => {
		if (!(caught instanceof MediaUsageActivationRequestError)) return false;
		const nextNotice = caught.kind === "version_mismatch" ? "version" : caught.kind;
		if (nextNotice !== "denied" && nextNotice !== "validation" && nextNotice !== "version")
			return false;
		setNotice(nextNotice);
		return true;
	}, []);
	const readProgress = React.useCallback(
		() =>
			queryClient.fetchQuery({
				queryKey: MEDIA_USAGE_PROGRESS_QUERY_KEY,
				queryFn: fetchMediaUsageProgress,
				retry: false,
				staleTime: 0,
			}),
		[queryClient],
	);
	const reconcileProgressFailure = React.useCallback(
		async (caught: unknown) => {
			if (handleProgressAccessError(caught)) return;
			try {
				const activation = await fetchMediaUsageActivationStatus();
				if (!mountedRef.current) return;
				queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, activation);
				let storedProgress: MediaUsageProgress | undefined;
				if (activation.state === "active") {
					storedProgress = await readProgress();
					if (!mountedRef.current) return;
				}
				setProgress(storedProgress);
				const storedFailure =
					activation.state === "activating" && activation.lastErrorCode !== null;
				setProgressRequestError(
					!storedFailure &&
						(activation.state === "activating" || storedProgress?.status === "indexing"),
				);
			} catch (error) {
				if (!mountedRef.current || handleProgressAccessError(error)) return;
				setProgressRequestError(true);
			}
		},
		[handleProgressAccessError, queryClient, readProgress],
	);
	const requestProgress = React.useCallback(() => {
		if (progressRequestRef.current) return progressRequestRef.current;
		const request = advanceMediaUsageProgress().finally(() => {
			if (progressRequestRef.current === request) progressRequestRef.current = null;
		});
		progressRequestRef.current = request;
		return request;
	}, []);
	const canDriveProgress =
		activationQuery.data !== undefined &&
		activationQuery.data.state !== "expanded" &&
		activationQuery.data.lastErrorCode === null;

	React.useEffect(() => {
		if (
			!isAdmin ||
			!pageVisible ||
			activationQuery.isFetching ||
			activationQuery.isError ||
			!canDriveProgress
		)
			return;
		let cancelled = false;
		let timer: number | undefined;
		let finishWait: (() => void) | undefined;
		const wait = (delayMs: 30_000) =>
			new Promise<void>((resolve) => {
				finishWait = () => {
					timer = undefined;
					finishWait = undefined;
					resolve();
				};
				timer = window.setTimeout(finishWait, delayMs);
			});
		void (async () => {
			if (activationQuery.data?.state === "active") {
				let storedProgress: MediaUsageProgress;
				try {
					storedProgress = await readProgress();
				} catch (error) {
					if (!cancelled) await reconcileProgressFailure(error);
					return;
				}
				if (cancelled || !mountedRef.current) return;
				setProgress(storedProgress);
				setProgressRequestError(false);
				if (storedProgress.status !== "indexing") return;
			}
			let delayMs: 0 | 30_000 = 0;
			for (;;) {
				if (delayMs === 30_000) await wait(delayMs);
				if (cancelled || !pageVisibleRef.current) return;
				let result: MediaUsageProgressAdvanceResponse;
				try {
					result = await requestProgress();
				} catch (error) {
					if (!cancelled) await reconcileProgressFailure(error);
					return;
				}
				queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, result.activation);
				if (result.progress)
					queryClient.setQueryData(MEDIA_USAGE_PROGRESS_QUERY_KEY, result.progress);
				if (cancelled || !mountedRef.current) return;
				setProgress(result.progress ?? undefined);
				setProgressRequestError(false);
				const storedFailure =
					result.activation.state === "activating" && result.activation.lastErrorCode !== null;
				if (
					storedFailure ||
					result.progress?.status === "needs_attention" ||
					result.nextRequestInMs === null
				)
					return;
				delayMs = result.nextRequestInMs;
			}
		})();
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
			finishWait?.();
		};
	}, [
		activationQuery.isError,
		activationQuery.isFetching,
		canDriveProgress,
		isAdmin,
		pageVisible,
		queryClient,
		readProgress,
		reconcileProgressFailure,
		requestProgress,
		resumeToken,
	]);

	React.useEffect(() => {
		if (!isAdmin) return;
		const visibilityChanged = () => {
			const visible = document.visibilityState !== "hidden";
			pageVisibleRef.current = visible;
			setPageVisible(visible);
			if (!visible) {
				wasHiddenRef.current = true;
				if (!submittingRef.current) closeDialog();
				return;
			}
			if (!wasHiddenRef.current) return;
			wasHiddenRef.current = false;
			void (async () => {
				const result = await activationQuery.refetch({ cancelRefetch: false });
				if (mountedRef.current && result.isSuccess) {
					if (submittingRef.current && result.data.state !== "expanded") closeDialog();
					setResumeToken((current) => current + 1);
				}
			})();
		};
		document.addEventListener("visibilitychange", visibilityChanged);
		return () => {
			document.removeEventListener("visibilitychange", visibilityChanged);
		};
	}, [activationQuery, closeDialog, isAdmin]);

	const advanceMutation = useMutation({
		mutationFn: async () => {
			await queryClient.cancelQueries({ queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY });
			return advanceMediaUsageActivation({ writersDrained: true });
		},
		retry: false,
		onSuccess: (result) => {
			queryClient.setQueryData(MEDIA_USAGE_ACTIVATION_QUERY_KEY, result.activation);
			setResumeToken((current) => current + 1);
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

	const title = t`Media usage tracking`;
	const description = t`Track where media is used across your content.`;
	if (userLoading) return <LoadingPage title={title} description={description} />;
	if (!isAdmin || isActivationError(activationQuery.error, "denied") || notice === "denied") {
		return (
			<MessagePage
				title={t`Access denied`}
				description={t`You need Admin permissions to manage media usage tracking.`}
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
				message={t`Couldn’t load media usage tracking settings.`}
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
	if (
		!activationReadError &&
		activation.state === "active" &&
		progress === undefined &&
		!progressRequestError
	) {
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
				title={t`Status`}
				actions={
					activationReadError ? (
						<Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>
							{t`Try again`}
						</Button>
					) : progressRequestError ? (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => {
								setProgressRequestError(false);
								setResumeToken((current) => current + 1);
							}}
						>
							{t`Try again`}
						</Button>
					) : undefined
				}
			>
				<StatusRow
					activation={activation}
					progress={progress}
					progressError={progressRequestError}
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
							{storedFailure ? t`Retry setup` : t`Enable tracking`}
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
	const ready = progress?.readyCollections ?? 0;
	const total = progress?.totalCollections ?? 0;
	const active = activation.state === "active";
	const settingUp = activation.state === "activating";
	const storedFailure = activation.state === "activating" && activation.lastErrorCode !== null;
	let heading = t`Media usage tracking is off`;
	let detail: React.ReactNode = t`Enable tracking to index existing content and keep references up to date.`;
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
			: progress?.status === "ready"
				? t`Media usage tracking is ready`
				: progress?.status === "needs_attention"
					? t`Needs attention`
					: t`Indexing existing content`;
		detail = progressError ? (
			t`Setup couldn’t continue. Try again.`
		) : progress?.status === "needs_attention" ? (
			t`Check the server logs, then use the media usage recovery API for the failed work.`
		) : progress?.status === "ready" ? (
			t`Existing content is indexed. New changes are tracked automatically.`
		) : progress ? (
			<>
				{t`Ready`}:{" "}
				<span dir="ltr" className="inline-block tabular-nums">
					{ready} / {total}
				</span>
			</>
		) : (
			t`EmDash is scanning existing content.`
		);
		badge = progressError
			? t`Needs attention`
			: progress?.status === "ready"
				? t`Ready`
				: progress?.status === "needs_attention"
					? t`Needs attention`
					: t`Indexing`;
		variant = progressError
			? "error"
			: progress?.status === "ready"
				? "success"
				: progress?.status === "needs_attention"
					? "error"
					: "warning";
	}
	if (activationError) {
		heading = t`Needs attention`;
		detail = t`Refresh status before continuing.`;
		badge = t`Needs attention`;
		variant = "error";
	}
	const progressing =
		!activationError &&
		((settingUp && !storedFailure) ||
			(active && !progressError && (!progress || progress.status === "indexing")));
	const isReady = !activationError && active && !progressError && progress?.status === "ready";
	const needsAttention = storedFailure || progressError || progress?.status === "needs_attention";
	return (
		<SettingRow>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0" role={needsAttention ? "alert" : undefined}>
					<div className="flex items-center gap-2">
						{progressing ? <Loader size="sm" /> : null}
						<h3
							ref={stateHeadingRef}
							tabIndex={-1}
							aria-live={needsAttention ? "off" : "polite"}
							aria-atomic="true"
							className="text-sm font-medium leading-5"
						>
							{heading}
						</h3>
					</div>
					<p className="mt-0.5 max-w-2xl text-sm leading-5 text-kumo-subtle">{detail}</p>
				</div>
				<Badge
					variant={variant}
					className={isReady ? "shrink-0 gap-1.5 rounded-md px-3 py-1.5 text-sm" : "shrink-0"}
				>
					{isReady ? <CheckCircle className="h-4 w-4" weight="fill" aria-hidden="true" /> : null}
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
	const [drainAcknowledged, setDrainAcknowledged] = React.useState(false);
	React.useEffect(() => {
		if (!open) setDrainAcknowledged(false);
	}, [open]);
	const confirm = () => {
		if (!drainAcknowledged || pending) return;
		onConfirm();
	};
	return (
		<ConfirmDialog
			open={open}
			onClose={() => onOpenChange(false)}
			title={retry ? t`Retry setup?` : t`Turn on media usage tracking?`}
			description={
				retry
					? t`EmDash will continue setup and resume scanning existing content.`
					: t`EmDash will scan existing content to show where media is used.`
			}
			confirmLabel={retry ? t`Retry setup` : t`Turn on`}
			pendingLabel={retry ? t`Retrying…` : t`Turning on…`}
			variant="primary"
			compact
			preventCloseWhilePending
			confirmDisabled={!drainAcknowledged}
			isPending={pending}
			error={null}
			onConfirm={confirm}
		>
			<div className="mt-4 grid gap-4 text-sm">
				<div className="grid gap-1.5">
					<p className="font-medium">{t`Before you continue:`}</p>
					<ul className="list-disc space-y-1 ps-5 leading-5 text-kumo-subtle">
						<li>{t`Finish any current edits.`}</li>
						<li>{t`Pause other tools that update content.`}</li>
						<li>{t`Wait for updates already in progress to finish.`}</li>
					</ul>
				</div>
				<p className="leading-5 text-kumo-subtle">
					{t`Keep this page open until setup finishes. If you leave, return to continue where it stopped.`}
				</p>
				<Checkbox
					checked={drainAcknowledged}
					onCheckedChange={setDrainAcknowledged}
					disabled={pending}
					label={t`I’ve completed these steps and understand tracking can’t be turned off.`}
				/>
			</div>
		</ConfirmDialog>
	);
}

function LoadingPage({ title, description }: { title: string; description: string }) {
	const { t } = useLingui();
	return (
		<SettingsFrame title={title} description={description}>
			<SettingsSection title={t`Status`}>
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading media usage tracking settings…`}
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
			<SettingsSection title={t`Status`}>
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
