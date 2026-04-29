import { ArrowRightIcon, CaretRightIcon, type IconProps } from "@phosphor-icons/react";

import { cn } from "../lib/utils";

/** Caret pointing in the "forward" direction — right in LTR, left in RTL. */
export function CaretNext({ className, ...props }: IconProps) {
	return <CaretRightIcon className={cn("rtl:-scale-x-100", className)} {...props} />;
}

/** Caret pointing in the "backward" direction — left in LTR, right in RTL. */
export function CaretPrev({ className, ...props }: IconProps) {
	return <CaretRightIcon className={cn("rotate-180 rtl:rotate-0", className)} {...props} />;
}

/** Arrow pointing in the "forward" direction — right in LTR, left in RTL. */
export function ArrowNext({ className, ...props }: IconProps) {
	return <ArrowRightIcon className={cn("rtl:-scale-x-100", className)} {...props} />;
}

/** Arrow pointing in the "backward" direction — left in LTR, right in RTL. */
export function ArrowPrev({ className, ...props }: IconProps) {
	return <ArrowRightIcon className={cn("rotate-180 rtl:rotate-0", className)} {...props} />;
}
