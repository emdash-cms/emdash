import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { BookingSchedulePanel } from "./BookingSchedulePanel.js";
import { OpenEnrollmentsPanel } from "./OpenEnrollmentsPanel.js";
import { ReservationsPanel } from "./ReservationsPanel.js";

type BookingView = "scheduled" | "open";

export function BookingsPanel() {
	const { t } = useLingui();
	const [view, setView] = React.useState<BookingView>("scheduled");
	return (
		<div className="space-y-6">
			<div className="flex flex-wrap gap-2 border-b border-kumo-line">
				<Button
					variant={view === "scheduled" ? "secondary" : "ghost"}
					onClick={() => setView("scheduled")}
				>
					{t`Scheduled bookings`}
				</Button>
				<Button variant={view === "open" ? "secondary" : "ghost"} onClick={() => setView("open")}>
					{t`Open enrollments`}
				</Button>
			</div>
			{view === "scheduled" ? (
				<>
					<BookingSchedulePanel />
					<ReservationsPanel />
				</>
			) : (
				<OpenEnrollmentsPanel />
			)}
		</div>
	);
}
