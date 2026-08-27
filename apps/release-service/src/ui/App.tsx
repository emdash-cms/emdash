import { ApproverPage } from "./ApproverPage.js";
import { Page } from "./components.js";
import { OperatorPage } from "./OperatorPage.js";
import { PublisherPage } from "./PublisherPage.js";

export function App() {
	const path = location.pathname;
	const content = path.startsWith("/admin") ? (
		<OperatorPage />
	) : path.startsWith("/approvals/") ? (
		<ApproverPage />
	) : (
		<PublisherPage />
	);
	return <Page>{content}</Page>;
}
