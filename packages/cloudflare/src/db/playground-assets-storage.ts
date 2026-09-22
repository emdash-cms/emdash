import type { Storage } from "emdash";
import { EmDashStorageError } from "emdash";

export interface PlaygroundMediaAsset {
	id: string;
	storageKey: string;
	filename: string;
	alt: string;
	mimeType: "image/jpeg";
	size: number;
	width: 1200;
	height: 800;
}

function mediaAsset(id: string, filename: string, alt: string, size: number): PlaygroundMediaAsset {
	return {
		id,
		storageKey: `playground-v1-${filename}`,
		filename,
		alt,
		mimeType: "image/jpeg",
		size,
		width: 1200,
		height: 800,
	};
}

export const PLAYGROUND_MEDIA_ASSETS: readonly PlaygroundMediaAsset[] = [
	mediaAsset(
		"01M1A5H7P30125M3W71HJ7XC2F",
		"building-long-term.jpg",
		"Code on a monitor in a dark room",
		153_471,
	),
	mediaAsset(
		"01M1A5H7P5ENTD9V05G0PZX6CZ",
		"case-for-static.jpg",
		"Laptop and coffee on a wooden table",
		114_942,
	),
	mediaAsset(
		"01M1A5H7P589NPKC1G1KXMWCZW",
		"learning-in-public.jpg",
		"Notebook and pen on a desk",
		241_878,
	),
	mediaAsset(
		"01M1A5H7P56RDVDAYQBZHE98P5",
		"small-tools.jpg",
		"Wrenches and hand tools hanging on a workshop wall",
		204_912,
	),
	mediaAsset(
		"01M1A5H7P55HBXRAMRKYJ170FS",
		"designing-with-constraints.jpg",
		"Pencils and design tools on a desk",
		55_811,
	),
	mediaAsset(
		"01M1A5H7P573FR41Y0MGQNZTW3",
		"weekend-side-project.jpg",
		"Code on a screen with a dark theme",
		123_495,
	),
	mediaAsset(
		"01M1A5H7P50MKJJ39ZGZH0K78M",
		"notes-on-simplicity.jpg",
		"Geometric pattern carved into white paper",
		147_485,
	),
];

const assetsByKey = new Map(PLAYGROUND_MEDIA_ASSETS.map((asset) => [asset.storageKey, asset]));
const PLAYGROUND_ASSETS_ORIGIN = "http://localhost";

export interface PlaygroundAssetFetcher {
	fetch(request: Request): Promise<Response>;
}

export class PlaygroundAssetsStorage implements Storage {
	constructor(private readonly assets: PlaygroundAssetFetcher) {}

	async upload(): Promise<never> {
		throw unsupported("Uploads are not available in Playground storage");
	}

	async download(key: string) {
		const asset = assetsByKey.get(key);
		if (!asset) throw notFound(key);

		let response: Response;
		try {
			response = await this.assets.fetch(
				new Request(`${PLAYGROUND_ASSETS_ORIGIN}/playground-media/${asset.storageKey}`),
			);
		} catch (error) {
			throw new EmDashStorageError(`Failed to download file: ${key}`, "DOWNLOAD_FAILED", error);
		}
		if (!response.ok || !response.body) throw notFound(key);

		return { body: response.body, contentType: asset.mimeType, size: asset.size };
	}

	async delete(): Promise<never> {
		throw unsupported("Deletes are not available in Playground storage");
	}

	async exists(key: string): Promise<boolean> {
		if (!assetsByKey.has(key)) return false;
		const response = await this.assets.fetch(
			new Request(`${PLAYGROUND_ASSETS_ORIGIN}/playground-media/${key}`, { method: "HEAD" }),
		);
		return response.ok;
	}

	async list(): Promise<never> {
		throw unsupported("Listing files is not available in Playground storage");
	}

	async getSignedUploadUrl(): Promise<never> {
		throw unsupported("Signed uploads are not available in Playground storage");
	}

	getPublicUrl(key: string): string {
		if (!assetsByKey.has(key)) throw notFound(key);
		return `/_emdash/api/media/file/${key}`;
	}
}

function notFound(key: string): EmDashStorageError {
	return new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
}

function unsupported(message: string): EmDashStorageError {
	return new EmDashStorageError(message, "NOT_SUPPORTED");
}
