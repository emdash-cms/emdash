import * as React from "react";

import {
	USER_AVATAR_PALETTES,
	USER_AVATAR_WAVES,
	mixHex,
	userAvatarInitials,
	userAvatarVariant,
	userAvatarWavePath,
} from "../lib/user-avatar.js";

export interface UserAvatarProps {
	user: { id: string; name?: string | null; avatarUrl?: string | null };
	/** Width and height in pixels. */
	size: number;
	/** Accessible name. Without one, the avatar is decorative and hidden from screen readers. */
	label?: string;
}

const RING_COLOR = "light-dark(rgb(0 0 0 / 0.08), rgb(255 255 255 / 0.1))";
const ID_UNSAFE_CHARS = /[^A-Za-z0-9_-]/g;

export function UserAvatar({ user, size, label }: UserAvatarProps) {
	const [loadedSrc, setLoadedSrc] = React.useState<string | null>(null);
	const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
	const src = user.avatarUrl && user.avatarUrl !== failedSrc ? user.avatarUrl : null;
	const loaded = src !== null && src === loadedSrc;
	const a11y = label
		? ({ role: "img", "aria-label": label } as const)
		: ({ "aria-hidden": true } as const);

	return (
		<span
			{...a11y}
			className="relative inline-block shrink-0 rounded-full"
			style={{ width: size, height: size }}
		>
			{!loaded && <GeneratedAvatar id={user.id} name={user.name} size={size} />}
			{src && (
				<img
					src={src}
					alt=""
					onLoad={() => setLoadedSrc(src)}
					onError={() => setFailedSrc(src)}
					className={`absolute inset-0 size-full rounded-full object-cover ${loaded ? "opacity-100" : "opacity-0"}`}
				/>
			)}
		</span>
	);
}

function GeneratedAvatar({
	id,
	name,
	size,
}: {
	id: string;
	name: string | null | undefined;
	size: number;
}) {
	const uid = `ua${React.useId().replace(ID_UNSAFE_CHARS, "")}`;
	const variant = userAvatarVariant(id);
	const palette = USER_AVATAR_PALETTES[variant.palette]!;
	const wavePath = userAvatarWavePath(USER_AVATAR_WAVES[variant.wave]!);
	const transform = `rotate(${variant.angle} 50 50)${variant.mirrored ? " translate(100 0) scale(-1 1)" : ""}`;

	const initials = userAvatarInitials(name);
	const shown = size < 24 ? initials.slice(0, 1) : initials;

	return (
		<svg
			viewBox="0 0 100 100"
			aria-hidden="true"
			className="block size-full forced-color-adjust-none"
		>
			<defs>
				<clipPath id={`${uid}c`}>
					<circle cx="50" cy="50" r="50" />
				</clipPath>
				<filter id={`${uid}b`} x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur stdDeviation="5" />
				</filter>
				<filter id={`${uid}s`} x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur stdDeviation="12" />
				</filter>
				<radialGradient id={`${uid}h`} cx="30%" cy="18%" r="62%">
					<stop offset="0" stopColor="#fff" stopOpacity="0.5" />
					<stop offset="1" stopColor="#fff" stopOpacity="0" />
				</radialGradient>
				<radialGradient id={`${uid}d`} cx="72%" cy="104%" r="70%">
					<stop offset="0" stopColor="#000" stopOpacity="0.16" />
					<stop offset="1" stopColor="#000" stopOpacity="0" />
				</radialGradient>
				{shown.length > 0 && (
					<filter id={`${uid}t`} x="-30%" y="-30%" width="160%" height="160%">
						<feDropShadow
							dx="0"
							dy="1.6"
							stdDeviation="1.4"
							floodColor={mixHex(palette.bottom, "#000000", 0.55)}
							floodOpacity="0.55"
						/>
						<feDropShadow
							dx="0"
							dy="0"
							stdDeviation="5"
							floodColor={mixHex(palette.bottom, "#000000", 0.35)}
							floodOpacity="0.35"
						/>
					</filter>
				)}
			</defs>
			<g clipPath={`url(#${uid}c)`}>
				<rect width="100" height="100" fill={palette.top} />
				<path
					d={wavePath}
					transform={`${transform} translate(0 -10)`}
					fill={mixHex(palette.top, palette.bottom, 0.45)}
					filter={`url(#${uid}s)`}
					opacity="0.7"
				/>
				<path d={wavePath} transform={transform} fill={palette.bottom} filter={`url(#${uid}b)`} />
				<rect width="100" height="100" fill={`url(#${uid}h)`} />
				<rect width="100" height="100" fill={`url(#${uid}d)`} />
			</g>
			<circle
				cx="50"
				cy="50"
				r="49.5"
				fill="none"
				strokeWidth={Math.max(1, 100 / size)}
				style={{ stroke: RING_COLOR }}
			/>
			{shown.length > 0 && (
				<text
					x="50"
					y="50"
					dy=".35em"
					textAnchor="middle"
					direction="ltr"
					unicodeBidi="isolate"
					fontSize={shown.length > 1 ? 38 : 44}
					fontWeight={600}
					fill="#fff"
					filter={`url(#${uid}t)`}
				>
					{shown.join("")}
				</text>
			)}
		</svg>
	);
}
