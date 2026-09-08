export type WorkloadIdentityErrorCode = "WORKLOAD_CONFIGURATION_INVALID" | "WORKLOAD_TOKEN_INVALID";

export class WorkloadIdentityError extends Error {
	readonly code: WorkloadIdentityErrorCode;

	constructor(code: WorkloadIdentityErrorCode) {
		super(code);
		this.name = "WorkloadIdentityError";
		this.code = code;
	}
}

export interface VerifiedWorkloadIdentity {
	issuer: "github-actions";
	subject: string;
	tokenId: string;
	repository: {
		name: string;
		id: string;
		owner: string;
		ownerId: string;
		visibility: "public" | "private" | "internal";
	};
	workflow: {
		ref: string;
		sha: string;
		jobRef: string | null;
		jobSha: string | null;
	};
	run: {
		id: string;
		attempt: number;
		actor: string;
		actorId: string;
		eventName: string;
		ref: string;
		refType: "branch" | "tag";
		commitSha: string;
		environment: string | null;
		runnerEnvironment: "github-hosted" | "self-hosted";
	};
	issuedAt: number;
	expiresAt: number;
}
