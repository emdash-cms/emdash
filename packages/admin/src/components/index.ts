// Layout components
export { Shell, type ShellProps } from "./Shell";
export { Sidebar, SidebarNav, type SidebarNavProps } from "./Sidebar";
export { Header } from "./Header";

// Page components
export { Dashboard, type DashboardProps } from "./Dashboard";
export { ContentList, type ContentListProps } from "./ContentList";
export { ContentEditor, type ContentEditorProps, type FieldDescriptor } from "./ContentEditor";
export { MediaLibrary, type MediaLibraryProps } from "./MediaLibrary";
export { MediaPickerModal, type MediaPickerModalProps } from "./MediaPickerModal";
export { Settings } from "./Settings";

// Rich text editor
export { PortableTextEditor, type PortableTextEditorProps } from "./PortableTextEditor";
export { GutenbergEditor, type GutenbergEditorProps } from "./GutenbergEditor";

// Buttons
export { SaveButton, type SaveButtonProps } from "./SaveButton";

// Auth components
export * from "./auth";
export { LoginPage } from "./LoginPage";
export { SetupWizard } from "./SetupWizard";
