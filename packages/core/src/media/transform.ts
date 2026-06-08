export interface MediaTransformDescriptor {
	/** Module path exporting createMediaTransform. */
	entrypoint: string;
	/** Serializable config passed to createMediaTransform at runtime. */
	config: unknown;
	/** Content types that should be buffered and passed to the transformer. */
	contentTypes?: string[];
}

export interface MediaTransformInput {
	body: ArrayBuffer;
	contentType: string;
	size?: number;
	key: string;
	request: Request;
}

export interface MediaTransformOutput {
	body: BodyInit;
	contentType: string;
	contentLength?: number;
	headers?: Record<string, string>;
}

export type MediaTransform = (
	input: MediaTransformInput,
) => Promise<MediaTransformOutput | null | undefined>;

export type CreateMediaTransformFn<TConfig = Record<string, unknown>> = (
	config: TConfig,
) => MediaTransform;
