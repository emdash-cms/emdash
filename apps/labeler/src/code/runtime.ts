import type { GuardedMediaTransport, MediaHostnameResolver } from "../assessment/media.js";
import {
	createBlobCachePackageBundleReader,
	type CodeAssessmentDependencies,
	type PackageProfileLocator,
	type PluginReviewer,
} from "./assessment.js";
import { createD1ReviewBudget, DEFAULT_REVIEW_BUDGET_LIMITS } from "./budget.js";

const MODEL_RE = /^[a-z0-9-]+\/[A-Za-z0-9@._/-]{1,128}$/;

export class CodeAssessmentConfigurationError extends Error {
	override readonly name = "CodeAssessmentConfigurationError";
}

/**
 * Code assessment stays off until `LABELER_CODE_REVIEW_MODELS` lists the
 * reviewer models. Once it is set, a missing `PLUGIN_REVIEW` binding is a
 * configuration error rather than a silent fallback to metadata-only
 * assessment.
 */
export function createProductionCodeAssessment(
	env: object,
	options: {
		db: D1Database;
		resolver: MediaHostnameResolver;
		transport: GuardedMediaTransport;
	},
): CodeAssessmentDependencies | undefined {
	const configured: unknown = Reflect.get(env, "LABELER_CODE_REVIEW_MODELS");
	if (configured === undefined || configured === "") return undefined;
	if (typeof configured !== "string") {
		throw new CodeAssessmentConfigurationError("LABELER_CODE_REVIEW_MODELS must be a string");
	}
	const models = [
		...new Set(
			configured
				.split(",")
				.map((model) => model.trim())
				.filter(Boolean),
		),
	];
	if (models.length === 0 || models.some((model) => !MODEL_RE.test(model))) {
		throw new CodeAssessmentConfigurationError("LABELER_CODE_REVIEW_MODELS is invalid");
	}
	const reviewer: unknown = Reflect.get(env, "PLUGIN_REVIEW");
	if (!isPluginReviewer(reviewer)) {
		throw new CodeAssessmentConfigurationError(
			"LABELER_CODE_REVIEW_MODELS is set but the PLUGIN_REVIEW service binding is missing",
		);
	}
	return {
		bundleReader: createBlobCachePackageBundleReader({
			resolver: options.resolver,
			transport: options.transport,
		}),
		reviewer,
		profiles: createD1PackageProfileLocator(options.db),
		models,
		budget: createD1ReviewBudget(options.db, {
			perPublisherPerDay: limit(
				env,
				"LABELER_CODE_REVIEW_DAILY_LIMIT_PER_PUBLISHER",
				DEFAULT_REVIEW_BUDGET_LIMITS.perPublisherPerDay,
			),
			totalPerDay: limit(
				env,
				"LABELER_CODE_REVIEW_DAILY_LIMIT",
				DEFAULT_REVIEW_BUDGET_LIMITS.totalPerDay,
			),
		}),
	};
}

export function createD1PackageProfileLocator(db: D1Database): PackageProfileLocator {
	return {
		async currentCid(profileUri) {
			const row = await db
				.prepare("SELECT cid FROM current_subjects WHERE uri = ? AND deleted_at IS NULL")
				.bind(profileUri)
				.first<{ cid: string }>();
			return row?.cid ?? null;
		},
	};
}

function limit(env: object, name: string, fallback: number): number {
	const value: unknown = Reflect.get(env, name);
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new CodeAssessmentConfigurationError(`${name} must be a positive integer`);
	}
	return parsed;
}

function isPluginReviewer(value: unknown): value is PluginReviewer {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "review") === "function"
	);
}
