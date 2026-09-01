import { ApproverPage } from "./ApproverPage.js";
import { Page } from "./components.js";
import { OperatorPage } from "./OperatorPage.js";
import { PublisherPage } from "./PublisherPage.js";

export function App() {
	const path = location.pathname;
	const content = path.startsWith("/admin") ? (
		<OperatorPage />
	) : path === "/approver" || path.startsWith("/approvals/") ? (
		<ApproverPage />
	) : (
		<div className="flex flex-col gap-6">
			<PublisherPage />
			<ApproverPage embedded />
		</div>
	);
	return <Page>{content}</Page>;
}
