/**
 * Shell: collapsible sidebar, header, and the product routes.
 *
 * Language and theme live in the chrome so switching tools does not dump them.
 * Each tool owns the rest of its own state.
 */

import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppHeader } from "./components/app-header.tsx";
import { AppSidebar } from "./components/app-sidebar.tsx";
import { CommandMenu, CommandMenuProvider } from "./components/command-menu.tsx";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { BookScreen } from "./book/BookScreen.tsx";
import { LibraryScreen } from "./book/LibraryScreen.tsx";
import { CacheSettingsPage } from "./settings/cache.tsx";
import { InterfaceSettingsPage } from "./settings/interface.tsx";
import { SettingsLayout } from "./settings/layout.tsx";
import { LlmSettingsPage } from "./settings/llm.tsx";
import { MaterialsSettingsPage } from "./settings/materials.tsx";
import { NarrationSettingsPage } from "./settings/narration.tsx";
import { YoutubeSettingsPage } from "./settings/youtube.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { VideoScreen } from "./video/VideoScreen.tsx";

function AppLayout() {
  const { pathname } = useLocation();
  const settings = pathname.startsWith("/settings");

  return (
    <CommandMenuProvider>
      <SidebarProvider className="h-full">
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
          <AppHeader />
          {settings ? (
            <Outlet />
          ) : (
            <div className="flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">
                <Outlet />
              </div>
            </div>
          )}
        </SidebarInset>
        <CommandMenu />
      </SidebarProvider>
    </CommandMenuProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<VideoScreen />} />
        <Route path="books" element={<LibraryScreen />} />
        <Route path="books/:bookId/:step?" element={<BookScreen />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="llm" replace />} />
          <Route path="llm" element={<LlmSettingsPage />} />
          <Route path="narration" element={<NarrationSettingsPage />} />
          <Route path="materials" element={<MaterialsSettingsPage />} />
          <Route path="youtube" element={<YoutubeSettingsPage />} />
          <Route path="cache" element={<CacheSettingsPage />} />
          <Route path="interface" element={<InterfaceSettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
