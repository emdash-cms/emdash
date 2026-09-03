/**
 * Type declarations for optional AWS SDK dependencies
 *
 * The AWS SDK is only required when using S3-compatible storage.
 * This file provides minimal type declarations to satisfy TypeScript
 * without requiring the SDK to be installed.
 */

declare module "@aws-sdk/client-s3" {
	export interface S3ClientConfig {
		endpoint: string;
		region: string;
		credentials: {
			accessKeyId: string;
			secretAccessKey: string;
		};
		forcePathStyle?: boolean;
	}

	export interface SdkStreamMixin {
		transformToWebStream(): ReadableStream;
	}

	export interface GetObjectResponse {
		Body?: SdkStreamMixin;
		ContentType?: string;
		ContentLength?: number;
		ETag?: string;
		LastModified?: Date;
	}

	export interface HeadObjectResponse {
		ContentType?: string;
		ContentLength?: number;
		ETag?: string;
		LastModified?: Date;
	}

	export interface ListObjectsV2Response {
		Contents?: Array<{
			Key?: string;
			Size?: number;
			LastModified?: Date;
			ETag?: string;
		}>;
		NextContinuationToken?: string;
	}

	export class S3Client {
		constructor(config: S3ClientConfig);
		send(command: GetObjectCommand): Promise<GetObjectResponse>;
		send(command: HeadObjectCommand): Promise<HeadObjectResponse>;
		send(command: ListObjectsV2Command): Promise<ListObjectsV2Response>;
		send(command: PutObjectCommand): Promise<void>;
		send(command: DeleteObjectCommand): Promise<void>;
		// Generic fallback
		send(command: unknown): Promise<unknown>;
	}

	export class PutObjectCommand {
		constructor(input: {
			Bucket: string;
			Key: string;
			Body?: unknown;
			ContentType?: string;
			ContentLength?: number;
			CacheControl?: string;
		});
	}

	export class GetObjectCommand {
		constructor(input: { Bucket: string; Key: string });
	}

	export class DeleteObjectCommand {
		constructor(input: { Bucket: string; Key: string });
	}

	export class HeadObjectCommand {
		constructor(input: { Bucket: string; Key: string });
	}

	export class ListObjectsV2Command {
		constructor(input: {
			Bucket: string;
			Prefix?: string;
			MaxKeys?: number;
			ContinuationToken?: string;
		});
	}
}

declare module "@aws-sdk/s3-request-presigner" {
	import type { S3Client } from "@aws-sdk/client-s3";

	export function getSignedUrl(
		client: S3Client,
		command: unknown,
		options: { expiresIn: number },
	): Promise<string>;
}
