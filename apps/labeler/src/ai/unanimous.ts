import type { ModerationModelIdentity, ModerationUsage, TextModerationAdapter } from "./types.js";

export const UNANIMOUS_TEXT_ADAPTER_VERSION = "listing-metadata-ai-unanimous-v1";

export function createUnanimousTextModerationAdapter(
	adapters: readonly [TextModerationAdapter, TextModerationAdapter, ...TextModerationAdapter[]],
): TextModerationAdapter {
	const identity = unanimousIdentity(
		adapters.map(({ identity: memberIdentity }) => memberIdentity),
	);
	return {
		identity,
		async moderate(request) {
			const results = await Promise.all(adapters.map((adapter) => adapter.moderate(request)));
			const coveredEvidenceRefs = results[0]!.coveredEvidenceRefs.filter((ref) =>
				results.every((result) => result.coveredEvidenceRefs.includes(ref)),
			);
			return {
				findings: results.flatMap(({ findings }) => findings),
				coveredEvidenceRefs,
				identity,
				latencyMs: Math.max(...results.map(({ latencyMs }) => latencyMs)),
				usage: combineUsage(results.map(({ usage }) => usage)),
			};
		},
	};
}

export function unanimousTextModelId(modelIds: readonly string[]): string {
	if (modelIds.length < 2 || modelIds.some((modelId) => modelId.length === 0)) {
		throw new TypeError("unanimous text moderation requires at least two model IDs");
	}
	const modelId = `unanimous:${modelIds.join("+")}`;
	if (modelId.length > 256) throw new TypeError("unanimous text model identity is too long");
	return modelId;
}

function unanimousIdentity(
	identities: readonly ModerationModelIdentity[],
): ModerationModelIdentity {
	const first = identities[0];
	if (!first || identities.length < 2) {
		throw new TypeError("unanimous text moderation requires at least two adapters");
	}
	if (
		identities.some(
			(identity) =>
				identity.promptVersion !== first.promptVersion || identity.promptHash !== first.promptHash,
		)
	) {
		throw new TypeError("unanimous text adapters must use the same prompt");
	}
	return {
		adapterVersion: UNANIMOUS_TEXT_ADAPTER_VERSION,
		modelId: unanimousTextModelId(identities.map(({ modelId }) => modelId)),
		promptVersion: first.promptVersion,
		promptHash: first.promptHash,
		parameters: {
			strategy: "unanimous-pass",
			members: identities.length,
			memberConfigurations: JSON.stringify(
				identities.map(({ adapterVersion, parameters }) => ({
					adapterVersion,
					parameters: Object.fromEntries(
						Object.entries(parameters).toSorted(([a], [b]) => a.localeCompare(b)),
					),
				})),
			),
		},
	};
}

function combineUsage(values: readonly ModerationUsage[]): ModerationUsage {
	const inputTokens = sumUsage(values, "inputTokens");
	const outputTokens = sumUsage(values, "outputTokens");
	const totalTokens = sumUsage(values, "totalTokens");
	const configuredUnits = sumUsage(values, "configuredUnits");
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(configuredUnits === undefined ? {} : { configuredUnits }),
	};
}

function sumUsage(
	values: readonly ModerationUsage[],
	key: keyof ModerationUsage,
): number | undefined {
	const items = values.map((value) => value[key]);
	if (items.some((value) => value === undefined)) return undefined;
	return items.reduce<number>((total, value) => total + value!, 0);
}
