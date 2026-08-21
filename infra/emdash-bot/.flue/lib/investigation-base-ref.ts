import type { InvestigationMode } from "./router.js";

export function investigationBaseRef(
	mode: InvestigationMode,
	mainBranchSha: string | null,
	previousBranchSha: string | null,
): string {
	if (mode === "revise") {
		if (!previousBranchSha) throw new Error("candidate branch is missing for revision");
		return previousBranchSha;
	}
	if (!mainBranchSha) throw new Error("main branch is missing");
	return mainBranchSha;
}
