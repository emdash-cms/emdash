import { Button, Popover, Tooltip } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useRoomPeers } from "../../lib/co-editing/hooks.js";
import type { PresenceUser, RoomEditing } from "../../lib/co-editing/types.js";
import { cn } from "../../lib/utils.js";
import { initials, scrollToField } from "./presence-format.js";
import { useAfterFirstPaint, useLeavingItems } from "./presence-motion.js";

const MAX_AVATARS = 3;
/** A circle's width, and what each one after the first adds, overlapping the one before by about a quarter. */
const FIRST_CIRCLE_PX = 30;
const NEXT_CIRCLE_PX = 23;

/** A person's circle: their photo, or their initials on their color. */
const FACE =
	"flex shrink-0 items-center justify-center rounded-full bg-(--emdash-author) font-semibold text-(color:--emdash-author-text) select-none";
/** Overlapping circles in the bar, cut apart by a ring in the bar's color. */
const STACKED =
	"relative size-7.5 text-[11px] leading-none ring-2 ring-kumo-elevated focus-visible:z-10";
const OVERLAP = "-ms-1.75";
const ENTER = "starting:scale-75 starting:opacity-0";
const LEAVING = "pointer-events-none scale-75 opacity-0";

/** Hovering a circle lifts it, and its neighbors less the further they are from it. */
const LIFT_PX = -4;
const LIFT_FALLOFF = 0.45;
const LIFT_SCALE = 1.05;
const LIFT_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SETTLE_EASE = "cubic-bezier(0.34, 3.85, 0.64, 1)";

export interface PresenceAvatarsProps {
	room: RoomEditing;
	/** The label a field goes by in the editor. */
	fieldLabel: (field: string) => string;
	/** Photos the admin already has, by user id. Anyone without one shows their initials. */
	photos?: ReadonlyMap<string, string>;
}

/**
 * The other people in the entry, for the editor bar: up to three circles, then "+N". It sits at
 * the end of a row and takes the room a sibling marked `data-presence-yields` gives up, showing
 * fewer circles when even that runs out, so it never makes the bar wrap.
 */
export function PresenceAvatars({ room, fieldLabel, photos }: PresenceAvatarsProps) {
	const { t } = useLingui();
	const users = useRoomPeers(room);
	const group = React.useRef<HTMLDivElement>(null);
	const slots = useCircleSlots(group, users.length > 0);
	const overflows = users.length > MAX_AVATARS || users.length > slots;
	const faces = overflows ? Math.max(0, Math.min(MAX_AVATARS, slots - 1)) : users.length;
	const visible = React.useMemo(() => users.slice(0, faces), [users, faces]);
	const more = users.length - visible.length;
	const shown = useLeavingItems(visible, more > 0 ? slots - 1 : slots);
	const animate = useAfterFirstPaint();
	if (users.length === 0 && shown.length === 0) return null;

	const describe = (user: PresenceUser) => {
		const { name } = user;
		if (user.field === null) return t`${name} · Viewing`;
		const field = fieldLabel(user.field);
		return t`${name} · Editing ${field}`;
	};
	const go = (user: PresenceUser) => {
		if (user.field !== null) scrollToField(room.id, user.field, user.id);
	};
	const label = plural(users.length, {
		one: "# other person here",
		other: "# other people here",
	});

	// Without room for a circle, screen readers still hear who is here.
	if (slots === 0 && shown.length === 0) {
		return (
			<div ref={group} role="group" aria-label={label} className="sr-only">
				<ul>
					{users.map((user) => (
						<li key={user.id}>{describe(user)}</li>
					))}
				</ul>
			</div>
		);
	}

	return (
		<div
			ref={group}
			role="group"
			aria-label={label}
			className="emdash-presence-avatars ms-auto flex shrink-0 items-center"
			onPointerOver={(event) => {
				const face = faceOf(event.currentTarget, event.target);
				if (face) lift(event.currentTarget, face);
			}}
			onPointerLeave={(event) => {
				const focused = event.currentTarget.querySelector(
					`:scope > ${FACE_SELECTOR}:focus-visible`,
				);
				settle(event.currentTarget, focused);
			}}
			onFocus={(event) => {
				const face = faceOf(event.currentTarget, event.target);
				if (face?.matches(":focus-visible")) lift(event.currentTarget, face);
			}}
			onBlur={(event) => {
				if (
					event.relatedTarget instanceof Node &&
					event.currentTarget.contains(event.relatedTarget)
				)
					return;
				const hovered = event.currentTarget.querySelector(`:scope > ${FACE_SELECTOR}:hover`);
				settle(event.currentTarget, hovered);
			}}
		>
			{shown.map(({ item: user, leaving }, index) => (
				<Tooltip
					key={user.id}
					content={describe(user)}
					render={
						<Button
							variant="ghost"
							shape="circle"
							size="sm"
							data-presence-face=""
							data-author-color={user.color}
							aria-label={describe(user)}
							// Focus still shows a viewer's name, but there's no field to go to.
							aria-disabled={user.field === null || undefined}
							aria-hidden={leaving || undefined}
							tabIndex={leaving ? -1 : undefined}
							className={cn(
								FACE,
								STACKED,
								"hover:bg-(--emdash-author)",
								index > 0 && OVERLAP,
								animate && ENTER,
								leaving && LEAVING,
							)}
							onClick={user.field === null ? undefined : () => go(user)}
						>
							<Face user={user} photo={photos?.get(user.id)} />
						</Button>
					}
				/>
			))}
			{more > 0 && slots > 0 && (
				<Everyone
					users={users}
					photos={photos}
					label={visible.length > 0 ? t`+${more}` : String(users.length)}
					ariaLabel={
						visible.length > 0
							? plural(more, { one: "Show # more person", other: "Show # more people" })
							: plural(users.length, {
									one: "Show the # person here",
									other: "Show the # people here",
								})
					}
					stacked={shown.length > 0}
					describeField={fieldLabel}
					onGo={go}
				/>
			)}
		</div>
	);
}

/** A person's photo, or their initials when there is none or it doesn't load. */
function Face({ user, photo }: { user: PresenceUser; photo: string | undefined }) {
	const [failed, setFailed] = React.useState<string | null>(null);
	if (photo && photo !== failed) {
		return (
			<img
				src={photo}
				alt=""
				loading="lazy"
				decoding="async"
				draggable={false}
				className="emdash-presence-photo size-full rounded-full object-cover"
				onError={() => setFailed(photo)}
			/>
		);
	}
	return <span dir="auto">{initials(user.name)}</span>;
}

const FACE_SELECTOR = "[data-presence-face]";

function faceOf(group: HTMLElement, target: EventTarget): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	const face = target.closest<HTMLElement>(FACE_SELECTOR);
	return face?.parentElement === group && !face.hasAttribute("aria-hidden") ? face : null;
}

/**
 * Lifts `active` by `LIFT_PX` and grows it, and lifts each other circle by a `LIFT_FALLOFF`
 * fraction of its neighbor's lift. Writes the styles directly, so hovering renders nothing.
 */
function lift(group: HTMLElement, active: Element) {
	const faces = group.querySelectorAll<HTMLElement>(`:scope > ${FACE_SELECTOR}`);
	const index = Array.prototype.indexOf.call(faces, active);
	group.style.setProperty("--emdash-presence-ease", LIFT_EASE);
	faces.forEach((face, position) => {
		const shift = LIFT_PX * LIFT_FALLOFF ** Math.abs(position - index);
		face.style.setProperty("--shift", `${Math.round(shift * 100) / 100}px`);
		face.style.setProperty("--scale-active", position === index ? String(LIFT_SCALE) : "1");
	});
}

/** Lifts `active` instead, or springs every circle back to rest without one. */
function settle(group: HTMLElement, active: Element | null) {
	if (active) {
		lift(group, active);
		return;
	}
	group.style.setProperty("--emdash-presence-ease", SETTLE_EASE);
	for (const face of group.querySelectorAll<HTMLElement>(`:scope > ${FACE_SELECTOR}`)) {
		face.style.setProperty("--shift", "0px");
		face.style.setProperty("--scale-active", "1");
	}
}

/**
 * How many circles fit at the end of the group's row without making it wrap, once the sibling
 * marked `data-presence-yields` has given up all its width.
 */
function useCircleSlots(group: React.RefObject<HTMLElement | null>, active: boolean): number {
	const [slots, setSlots] = React.useState(MAX_AVATARS + 1);
	React.useLayoutEffect(() => {
		const row = group.current?.parentElement;
		if (!active || !row) return;
		const measure = () => {
			const { columnGap, display } = getComputedStyle(row);
			if (!display.includes("flex")) {
				setSlots(MAX_AVATARS + 1);
				return;
			}
			const gap = Number.parseFloat(columnGap) || 0;
			let others = 0;
			let items = 0;
			for (const child of row.children) {
				if (child === group.current || !(child instanceof HTMLElement)) continue;
				if (child.getClientRects().length === 0) continue;
				items++;
				if (!child.hasAttribute("data-presence-yields")) others += child.offsetWidth;
			}
			const free = row.clientWidth - others - gap * items;
			setSlots(
				free < FIRST_CIRCLE_PX
					? 0
					: Math.min(MAX_AVATARS + 1, 1 + Math.floor((free - FIRST_CIRCLE_PX) / NEXT_CIRCLE_PX)),
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		for (const child of row.children) {
			if (child !== group.current && !child.hasAttribute("data-presence-yields")) {
				observer.observe(child);
			}
		}
		return () => observer.disconnect();
	}, [group, active]);
	return slots;
}

function Everyone({
	users,
	photos,
	label,
	ariaLabel,
	stacked,
	describeField,
	onGo,
}: {
	users: readonly PresenceUser[];
	photos: ReadonlyMap<string, string> | undefined;
	label: string;
	ariaLabel: string;
	stacked: boolean;
	describeField: (field: string) => string;
	onGo: (user: PresenceUser) => void;
}) {
	const { t } = useLingui();
	const [open, setOpen] = React.useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button
					variant="ghost"
					shape="circle"
					size="sm"
					data-presence-face=""
					aria-label={ariaLabel}
					className={cn(
						STACKED,
						"bg-kumo-fill font-semibold hover:bg-kumo-fill",
						stacked && OVERLAP,
					)}
				>
					<span dir="ltr">{label}</span>
				</Button>
			</Popover.Trigger>
			<Popover.Content align="end" className="w-72 max-w-[calc(100vw-2rem)] p-1">
				<Popover.Title className="sr-only">{t`People in this entry`}</Popover.Title>
				<ul className="grid">
					{users.map((user) => {
						const field = user.field === null ? null : describeField(user.field);
						const status = field === null ? t`Viewing` : t`Editing ${field}`;
						const row = (
							<>
								<span
									data-author-color={user.color}
									aria-hidden="true"
									className={cn(FACE, "size-6 text-[11px] leading-none")}
								>
									<Face user={user} photo={photos?.get(user.id)} />
								</span>
								<span dir="auto" className="min-w-0 flex-1 truncate text-start">
									{user.name}
								</span>
								<span className="shrink-0 text-kumo-subtle">{status}</span>
							</>
						);
						return (
							<li key={user.id}>
								{user.field === null ? (
									<div className={ROW}>{row}</div>
								) : (
									<Button
										variant="ghost"
										className={cn(ROW, "h-auto w-full font-normal")}
										onClick={() => {
											setOpen(false);
											onGo(user);
										}}
									>
										{row}
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			</Popover.Content>
		</Popover>
	);
}

const ROW = "flex items-center gap-2.5 rounded px-2 py-1.5 text-base";
