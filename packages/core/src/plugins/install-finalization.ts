import type { ApiResult } from "../api/types.js";

export interface PluginInstallFinalizationOptions {
	pluginId: string;
	syncRuntime(): Promise<void>;
	runLifecycle(): Promise<void>;
	rollback(): Promise<ApiResult<unknown>>;
}

export interface PluginUpdateFinalizationOptions extends PluginInstallFinalizationOptions {
	runRollbackLifecycle(): Promise<void>;
}

export async function finalizePluginInstall(
	options: PluginInstallFinalizationOptions,
): Promise<void> {
	try {
		await options.syncRuntime();
		await options.runLifecycle();
	} catch (installError) {
		const failures: unknown[] = [installError];
		try {
			const rollback = await options.rollback();
			if (!rollback.success) failures.push(new Error(rollback.error.message));
		} catch (rollbackError) {
			failures.push(rollbackError);
		}
		try {
			await options.syncRuntime();
		} catch (syncError) {
			failures.push(syncError);
		}
		if (failures.length > 1) {
			const rollbackError = new Error(
				`Plugin ${options.pluginId} installation failed and rollback did not complete`,
				{ cause: installError },
			);
			Object.defineProperty(rollbackError, "errors", { value: failures });
			throw rollbackError;
		}
		throw installError;
	}
}

export async function finalizePluginUpdate(
	options: PluginUpdateFinalizationOptions,
): Promise<void> {
	try {
		await options.syncRuntime();
		await options.runLifecycle();
	} catch (updateError) {
		const failures: unknown[] = [updateError];
		let rollbackSucceeded = false;
		try {
			const rollback = await options.rollback();
			rollbackSucceeded = rollback.success;
			if (!rollback.success) failures.push(new Error(rollback.error.message));
		} catch (rollbackError) {
			failures.push(rollbackError);
		}
		try {
			await options.syncRuntime();
			if (rollbackSucceeded) await options.runRollbackLifecycle();
		} catch (syncError) {
			failures.push(syncError);
		}
		if (failures.length > 1) {
			const rollbackError = new Error(
				`Plugin ${options.pluginId} update failed and rollback did not complete`,
				{ cause: updateError },
			);
			Object.defineProperty(rollbackError, "errors", { value: failures });
			throw rollbackError;
		}
		throw updateError;
	}
}
