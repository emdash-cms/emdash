import { useLingui } from "@lingui/react/macro";
import type * as React from "react";

/**
 * EmDash icon mark — the rounded-rect em dash symbol.
 * Used in the sidebar brand and as favicon.
 */
export function LogoIcon(props: React.SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 75 75" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
			<rect
				x="3"
				y="3"
				width="69"
				height="69"
				rx="10.518"
				stroke="url(#emdash-icon-border)"
				strokeWidth="6"
			/>
			<rect x="18" y="34" width="39.3661" height="6.56101" fill="url(#emdash-icon-dash)" />
			<defs>
				<linearGradient
					id="emdash-icon-border"
					x1="-42.9996"
					y1="124"
					x2="92.4233"
					y2="-41.7456"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#0F006B" />
					<stop offset="0.0833" stopColor="#281A81" />
					<stop offset="0.1667" stopColor="#5D0C83" />
					<stop offset="0.25" stopColor="#911475" />
					<stop offset="0.3333" stopColor="#CE2F55" />
					<stop offset="0.4167" stopColor="#FF6633" />
					<stop offset="0.5" stopColor="#F6821F" />
					<stop offset="0.5833" stopColor="#FBAD41" />
					<stop offset="0.6667" stopColor="#FFCD89" />
					<stop offset="0.75" stopColor="#FFE9CB" />
					<stop offset="0.8333" stopColor="#FFF7EC" />
					<stop offset="0.9167" stopColor="#FFF8EE" />
					<stop offset="1" stopColor="white" />
				</linearGradient>
				<linearGradient
					id="emdash-icon-dash"
					x1="91.4992"
					y1="27.4982"
					x2="28.1217"
					y2="54.1775"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="white" />
					<stop offset="0.1293" stopColor="#FFF8EE" />
					<stop offset="0.6171" stopColor="#FBAD41" />
					<stop offset="0.848" stopColor="#F6821F" />
					<stop offset="1" stopColor="#FF6633" />
				</linearGradient>
			</defs>
		</svg>
	);
}

/**
 * Full logo lockup — icon + "EmDash" wordmark.
 * Renders both dark-text and light-text variants, switching via CSS `light-dark()`.
 */
export function LogoLockup({ className, ...props }: React.SVGProps<SVGSVGElement>) {
	const { t } = useLingui();
	return (
		<svg
			viewBox="0 0 471 118"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			role="img"
			aria-label={t`EmDash`}
			{...props}
		>
			{/* Icon mark */}
			<path
				d="M0.410156 96.5125V21.2097C0.410156 9.48841 9.91245 -0.013916 21.6338 -0.013916V9.40601L21.3291 9.40991C14.9509 9.57133 9.83008 14.7927 9.83008 21.2097V96.5125C9.83008 102.93 14.9509 108.151 21.3291 108.312L21.6338 108.316H96.9365L97.2412 108.312C103.518 108.153 108.577 103.094 108.736 96.8171L108.74 96.5125V21.2097C108.74 14.6909 103.455 9.40601 96.9365 9.40601V-0.013916C108.658 -0.013916 118.16 9.48838 118.16 21.2097V96.5125C118.16 108.234 108.658 117.736 96.9365 117.736H21.6338C9.91248 117.736 0.410156 108.234 0.410156 96.5125ZM96.9365 -0.013916V9.40601H21.6338V-0.013916H96.9365Z"
				fill="url(#emdash-lockup-icon)"
			/>
			<path d="M28.6699 53.366H90.4746V63.6668H28.6699V53.366Z" fill="url(#emdash-lockup-dash)" />
			{/* Wordmark — uses currentColor so it adapts to light/dark context */}
			<path
				d="M154.762 90V27.4834H194.447V35.8449H164.467V54.0844H192.844V62.2293H164.467V81.6385H194.447V90H154.762Z"
				fill="currentColor"
			/>
			<path
				d="M204.172 90V44.4231H213.53V51.4849H213.747C215.697 46.7193 220.332 43.5566 226.311 43.5566C232.593 43.5566 237.185 46.8059 239.005 52.5247H239.222C241.561 46.9792 246.933 43.5566 253.432 43.5566C262.443 43.5566 268.335 49.5353 268.335 58.6767V90H258.934V60.9296C258.934 54.9942 255.771 51.5716 250.226 51.5716C244.68 51.5716 240.825 55.7307 240.825 61.4928V90H231.64V60.2364C231.64 54.9508 228.304 51.5716 223.018 51.5716C217.473 51.5716 213.53 55.9473 213.53 61.8394V90H204.172Z"
				fill="currentColor"
			/>
			<path
				d="M279.404 90V27.4834H301.456C319.998 27.4834 331.046 38.8776 331.046 58.5467V58.6334C331.046 78.3892 320.085 90 301.456 90H279.404ZM289.108 81.5951H300.546C313.803 81.5951 321.125 73.4935 321.125 58.72V58.6334C321.125 43.9465 313.716 35.8449 300.546 35.8449H289.108V81.5951Z"
				fill="currentColor"
			/>
			<path
				d="M353.379 90.8232C344.281 90.8232 338.172 85.2344 338.172 77.0461V76.9595C338.172 69.0312 344.324 64.1789 355.112 63.529L367.502 62.7925V59.3699C367.502 54.3443 364.253 51.3116 358.448 51.3116C353.032 51.3116 349.696 53.8677 348.916 57.507L348.83 57.8969H339.992L340.035 57.4203C340.685 49.5787 347.487 43.5566 358.708 43.5566C369.842 43.5566 376.904 49.4487 376.904 58.5901V90H367.502V82.8082H367.329C364.686 87.7038 359.401 90.8232 353.379 90.8232ZM347.617 76.8295C347.617 80.8153 350.909 83.3281 355.935 83.3281C362.52 83.3281 367.502 78.8657 367.502 72.9303V69.3778L356.368 70.0709C350.736 70.4175 347.617 72.887 347.617 76.7428V76.8295Z"
				fill="currentColor"
			/>
			<path
				d="M403.959 90.9098C392.564 90.9098 385.893 85.2777 384.939 76.9595L384.896 76.5695H394.167L394.254 77.0028C395.121 81.2052 398.24 83.6747 404.002 83.6747C409.634 83.6747 413.013 81.3352 413.013 77.6527V77.6093C413.013 74.6633 411.367 72.9737 406.471 71.8039L399.02 70.1143C390.355 68.1214 386.066 63.9623 386.066 57.3337V57.2903C386.066 49.1454 393.171 43.5566 403.655 43.5566C414.443 43.5566 420.942 49.5787 421.418 57.3337L421.462 57.8536H412.667L412.624 57.5503C412.06 53.5645 408.941 50.7917 403.655 50.7917C398.63 50.7917 395.467 53.1746 395.467 56.8138V56.8571C395.467 59.6732 397.33 61.5794 402.226 62.7492L409.634 64.4388C418.949 66.605 422.501 70.2876 422.501 76.8295V76.8728C422.501 85.191 414.703 90.9098 403.959 90.9098Z"
				fill="currentColor"
			/>
			<path
				d="M431.014 90V27.4834H440.372V51.9182H440.588C443.014 46.6326 447.91 43.5566 454.712 43.5566C464.46 43.5566 470.872 50.8351 470.872 61.8394V90H461.514V63.6157C461.514 56.0773 457.701 51.5716 451.116 51.5716C444.661 51.5716 440.372 56.5105 440.372 63.6157V90H431.014Z"
				fill="currentColor"
			/>
			<defs>
				<linearGradient
					id="emdash-lockup-icon"
					x1="-67.1002"
					y1="194.666"
					x2="145.514"
					y2="-65.5554"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#0F006B" />
					<stop offset="0.0833" stopColor="#281A81" />
					<stop offset="0.1667" stopColor="#5D0C83" />
					<stop offset="0.25" stopColor="#911475" />
					<stop offset="0.3333" stopColor="#CE2F55" />
					<stop offset="0.4167" stopColor="#FF6633" />
					<stop offset="0.5" stopColor="#F6821F" />
					<stop offset="0.5833" stopColor="#FBAD41" />
					<stop offset="0.6667" stopColor="#FFCD89" />
					<stop offset="0.75" stopColor="#FFE9CB" />
					<stop offset="0.8333" stopColor="#FFF7EC" />
					<stop offset="0.9167" stopColor="#FFF8EE" />
					<stop offset="1" stopColor="white" />
				</linearGradient>
				<linearGradient
					id="emdash-lockup-dash"
					x1="144.064"
					y1="43.1581"
					x2="44.5609"
					y2="85.0447"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="white" />
					<stop offset="0.1293" stopColor="#FFF8EE" />
					<stop offset="0.6171" stopColor="#FBAD41" />
					<stop offset="0.848" stopColor="#F6821F" />
					<stop offset="1" stopColor="#FF6633" />
				</linearGradient>
			</defs>
		</svg>
	);
}
