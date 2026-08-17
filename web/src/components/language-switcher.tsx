import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, useI18n } from "@/i18n/index.tsx";

export function LanguageSwitcher() {
  const { t, language, setLanguage } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs">
          {LANGUAGE_NAMES[language] ?? language}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
        {SUPPORTED_LANGUAGES.map((code) => (
          <DropdownMenuItem key={code} onClick={() => setLanguage(code)}>
            {language === code ? <Check /> : <span className="size-4" />}
            {LANGUAGE_NAMES[code] ?? code}
            <span className="sr-only">{t("Language")}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
