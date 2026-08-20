import { AudioLines, Database, HardDrive, SlidersHorizontal, Sparkles, Youtube, type LucideIcon } from "lucide-react";

export const SETTINGS_SECTIONS = [
  {
    id: "llm",
    path: "/settings/llm",
    titleKey: "LLM Settings Tab",
    descriptionKey: "Settings Llm Description",
    icon: Sparkles,
    iconClass: "bg-violet-600 text-white",
  },
  {
    id: "narration",
    path: "/settings/narration",
    titleKey: "Narration Settings Tab",
    descriptionKey: "Settings Narration Description",
    icon: AudioLines,
    iconClass: "bg-rose-600 text-white",
  },
  {
    id: "materials",
    path: "/settings/materials",
    titleKey: "Material API Tab",
    descriptionKey: "Settings Materials Description",
    icon: Database,
    iconClass: "bg-teal-600 text-white",
  },
  {
    id: "youtube",
    path: "/settings/youtube",
    titleKey: "YouTube Settings Tab",
    descriptionKey: "Settings Youtube Description",
    icon: Youtube,
    iconClass: "bg-red-600 text-white",
  },
  {
    id: "cache",
    path: "/settings/cache",
    titleKey: "Cache Management Tab",
    descriptionKey: "Settings Cache Description",
    icon: HardDrive,
    iconClass: "bg-amber-500 text-white",
  },
  {
    id: "interface",
    path: "/settings/interface",
    titleKey: "Interface Settings Tab",
    descriptionKey: "Settings Interface Description",
    icon: SlidersHorizontal,
    iconClass: "bg-sky-600 text-white",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  path: string;
  titleKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  iconClass: string;
}>;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
