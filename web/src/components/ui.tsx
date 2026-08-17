/**
 * App-level UI helpers on top of shadcn primitives.
 *
 * Screens keep a small, stable API (Card with a title, Select with options,
 * Field + hint) while the look comes from `@/components/ui/*`.
 */

import type { ReactNode } from "react";
import { Alert as UiAlert, AlertDescription } from "@/components/ui/alert";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Button as UiButton, buttonVariants } from "@/components/ui/button";
import { Card as UiCard, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog as UiDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress as UiProgress } from "@/components/ui/progress";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider as UiSlider } from "@/components/ui/slider";
import { Switch as UiSwitch } from "@/components/ui/switch";
import { Tabs as UiTabs, TabsContent, TabsList as UiTabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export { cn };

const EMPTY_SELECT_VALUE = "__empty__";

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <UiCard className={cn("gap-4 py-4", className)}>
      {(title || action) && (
        <CardHeader className="grid-rows-1 px-4 pb-0">
          {title && <CardTitle className="text-sm">{title}</CardTitle>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className="px-4">{children}</CardContent>
    </UiCard>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label && <Label className="text-xs text-muted-foreground">{label}</Label>}
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TextInput(props: React.ComponentProps<typeof Input>) {
  return <Input {...props} />;
}

export function TextArea(props: React.ComponentProps<typeof Textarea>) {
  return <Textarea {...props} />;
}

export function NumberInput(props: React.ComponentProps<typeof Input>) {
  return <Input type="number" {...props} />;
}

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <UiSelect
      value={value === "" ? EMPTY_SELECT_VALUE : value}
      onValueChange={(next) => onValueChange(next === EMPTY_SELECT_VALUE ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem
            key={option.value || EMPTY_SELECT_VALUE}
            value={option.value === "" ? EMPTY_SELECT_VALUE : option.value}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <UiSwitch checked={checked} onCheckedChange={onCheckedChange} />
      {label && <Label className="font-normal">{label}</Label>}
    </div>
  );
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 1,
  step = 0.1,
  format,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <UiSlider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onValueChange(next ?? min)}
      />
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANT = {
  default: "outline",
  primary: "default",
  danger: "destructive",
  ghost: "ghost",
} as const;

const BUTTON_SIZE = {
  sm: "sm",
  md: "default",
  lg: "lg",
} as const;

export function buttonClass({
  variant = "default",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(buttonVariants({ variant: BUTTON_VARIANT[variant], size: BUTTON_SIZE[size] }), className);
}

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <UiButton
      variant={BUTTON_VARIANT[variant]}
      size={BUTTON_SIZE[size]}
      className={className}
      {...props}
    />
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
      />
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export const Tabs = UiTabs;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <UiTabsList className={cn("mb-4 h-auto w-full flex-wrap justify-start", className)}>
      {children}
    </UiTabsList>
  );
}

export function TabTrigger({ value, children }: { value: string; children: ReactNode }) {
  return <TabsTrigger value={value}>{children}</TabsTrigger>;
}

export const TabContent = TabsContent;

export function Dialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <UiDialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </UiDialog>
  );
}

export function Progress({ value }: { value: number }) {
  return <UiProgress value={value} />;
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const tones = {
    info: "",
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    danger: "",
  };
  return (
    <UiAlert variant={tone === "danger" ? "destructive" : "default"} className={tones[tone]}>
      <AlertDescription className={tone === "danger" ? "text-destructive" : undefined}>{children}</AlertDescription>
    </UiAlert>
  );
}

export function Badge({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "success" | "warning" | "danger" | "accent";
  children: ReactNode;
}) {
  const tones = {
    muted: "bg-secondary text-secondary-foreground",
    success: "border-transparent bg-success/15 text-success",
    warning: "border-transparent bg-warning/15 text-warning",
    danger: "",
    accent: "",
  };
  return (
    <UiBadge
      variant={tone === "danger" ? "destructive" : tone === "accent" ? "default" : "secondary"}
      className={tones[tone]}
    >
      {children}
    </UiBadge>
  );
}
