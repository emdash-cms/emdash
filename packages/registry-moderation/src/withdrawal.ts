import {
	isVerifiedListingLabel,
	parseListingLabel,
	type VerifiedListingLabel,
} from "./label-crypto.js";
import { isListingLabelActive, reduceListingLabels, type ListingLabelEvent } from "./labels.js";

export const LEGACY_RELEASE_WITHDRAWAL_LABEL = "security:yanked";
export const RELEASE_WITHDRAWAL_LABEL = "security-yanked";

const RELEASE_WITHDRAWAL_VALUES = new Set<string>([
	LEGACY_RELEASE_WITHDRAWAL_LABEL,
	RELEASE_WITHDRAWAL_LABEL,
]);

export interface ReleaseWithdrawalInput<Label extends ListingLabelEvent> {
	uri: string;
	cid: string;
	labels: readonly Label[];
	evaluatedAt: Date | string;
	acceptedSources?: readonly string[];
}

export interface ReleaseWithdrawalResult {
	withdrawn: boolean;
	applicableLabels: readonly ListingLabelEvent[];
}

export function evaluateReleaseWithdrawal(
	input: ReleaseWithdrawalInput<VerifiedListingLabel>,
): ReleaseWithdrawalResult {
	for (const label of input.labels) {
		if (!isVerifiedListingLabel(label)) {
			throw new TypeError("withdrawal labels must be verified before evaluation");
		}
	}
	return evaluateReleaseWithdrawalCore(input);
}

/** Evaluates labels loaded from a store that authenticated them before persistence. */
export function evaluateHydratedReleaseWithdrawal(
	input: ReleaseWithdrawalInput<ListingLabelEvent>,
): ReleaseWithdrawalResult {
	return evaluateReleaseWithdrawalCore({
		...input,
		labels: input.labels.map((label) => parseListingLabel(label)),
	});
}

function evaluateReleaseWithdrawalCore(
	input: ReleaseWithdrawalInput<ListingLabelEvent>,
): ReleaseWithdrawalResult {
	const acceptedSources =
		input.acceptedSources === undefined ? null : new Set(input.acceptedSources);
	const reduction = reduceListingLabels(input.labels, input.evaluatedAt);
	const applicableLabels = reduction.states.flatMap((state) => {
		const candidates =
			state.collision.length > 0 ? state.collision : state.active ? [state.winner] : [];
		return candidates.filter(
			(label) =>
				RELEASE_WITHDRAWAL_VALUES.has(label.val) &&
				isListingLabelActive(label, input.evaluatedAt) &&
				label.uri === input.uri &&
				(label.cid === undefined || label.cid === input.cid) &&
				(acceptedSources === null || acceptedSources.has(label.src)),
		);
	});
	return { withdrawn: applicableLabels.length > 0, applicableLabels };
}
