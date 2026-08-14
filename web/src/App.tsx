/**
 * Shell: shared chrome and the two tools as real routes.
 *
 * Language and basic settings live here so switching between short video and
 * audiobook does not dump them. Each tool owns the rest of its own state.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronUp, Clapperboard } from "lucide-react";
import { NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { api } from "./api/client.ts";
import { BookScreen } from "./book/BookScreen.tsx";
import { LibraryScreen } from "./book/LibraryScreen.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { Badge, Button, Select, buttonClass } from "./components/ui.tsx";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, useI18n } from "./i18n/index.tsx";
import { VideoScreen } from "./video/VideoScreen.tsx";

function AppLayout() {
  const { t, language, setLanguage } = useI18n();
  const [showSettings, setShowSettings] = useState(false);
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">VidGen 🎬</h1>
          {health.data && (
            <Badge tone={health.data.database === "ok" && health.data.ffmpeg === "ok" ? "success" : "danger"}>
              v{health.data.version}
            </Badge>
          )}
          {health.data && health.data.ffmpeg !== "ok" && <Badge tone="danger">ffmpeg missing</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <nav className="flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1">
            <NavLink
              to="/"
              end
              className={({ isActive }) => buttonClass({ size: "sm", variant: isActive ? "primary" : "ghost" })}
            >
              <Clapperboard size={14} />
              {t("Mode Short Video")}
            </NavLink>
            <NavLink
              to="/books"
              className={({ isActive }) => buttonClass({ size: "sm", variant: isActive ? "primary" : "ghost" })}
            >
              <BookOpen size={14} />
              {t("Mode Audiobook")}
            </NavLink>
          </nav>

          <div className="w-40">
            <Select
              value={language}
              onValueChange={setLanguage}
              options={SUPPORTED_LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] ?? code }))}
            />
          </div>
          <Button size="sm" onClick={() => setShowSettings((current) => !current)}>
            {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {t("Basic Settings")}
          </Button>
        </div>
      </header>

      {showSettings && (
        <div className="mb-5">
          <SettingsPanel />
        </div>
      )}

      <Outlet />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<VideoScreen />} />
        <Route path="books" element={<LibraryScreen />} />
        <Route path="books/:bookId/:step?" element={<BookScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
