import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { BookOpen, Clapperboard, ListTodo, Monitor, Moon, Sun } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useI18n } from "@/i18n/index.tsx";
import { SETTINGS_SECTIONS } from "@/settings/nav.ts";

interface CommandMenuValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandMenuContext = createContext<CommandMenuValue | null>(null);

export function useCommandMenu(): CommandMenuValue {
  const context = useContext(CommandMenuContext);
  if (!context) throw new Error("useCommandMenu must be used inside CommandMenuProvider");
  return context;
}

export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <CommandMenuContext.Provider value={{ open, setOpen }}>{children}</CommandMenuContext.Provider>;
}

export function CommandMenu() {
  const { t } = useI18n();
  const { open, setOpen } = useCommandMenu();
  const navigate = useNavigate();
  const { setTheme } = useTheme();

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t("Search Commands")} description={t("Search Commands Hint")}>
      <CommandInput placeholder={t("Search Commands Hint")} />
      <CommandList>
        <CommandEmpty>{t("No Commands Found")}</CommandEmpty>
        <CommandGroup heading={t("Nav Create")}>
          <CommandItem onSelect={() => go("/")}>
            <Clapperboard />
            {t("Mode Short Video")}
          </CommandItem>
          <CommandItem onSelect={() => go("/books")}>
            <BookOpen />
            {t("Book Library")}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("Nav Workspace")}>
          <CommandItem onSelect={() => go("/tasks")}>
            <ListTodo />
            {t("Task Manager")}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("Settings")}>
          {SETTINGS_SECTIONS.map((section) => (
            <CommandItem key={section.id} onSelect={() => go(section.path)}>
              <section.icon />
              {t(section.titleKey)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("Appearance")}>
          <CommandItem onSelect={() => { setTheme("light"); setOpen(false); }}>
            <Sun />
            {t("Theme Light")}
          </CommandItem>
          <CommandItem onSelect={() => { setTheme("dark"); setOpen(false); }}>
            <Moon />
            {t("Theme Dark")}
          </CommandItem>
          <CommandItem onSelect={() => { setTheme("system"); setOpen(false); }}>
            <Monitor />
            {t("Theme System")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
