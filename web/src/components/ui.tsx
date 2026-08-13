/**
 * Small UI primitives shared by every panel.
 *
 * Radix supplies the accessible behaviour (focus management, keyboard nav,
 * portals); the styling stays local so the whole app reads as one system
 * without pulling in a component library.
 */

import * as SelectPrimitive from "@radix-ui/react-select";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, ChevronDown, X } from "lucide-react";
import { clsx } from "clsx";
import type { ReactNode } from "react";

export function cn(...values: (string | false | null | undefined)[]): string {
  return clsx(values);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

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
    <section
      className={cn(
        "rounded-xl border border-border bg-surface p-4 shadow-sm",
        className,
      )}
    >
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
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
    <label className={cn("block", className)}>
      {label && <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const CONTROL_CLASS =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text " +
  "outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL_CLASS, props.className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(CONTROL_CLASS, "resize-y", props.className)} />;
}

export function NumberInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" {...props} className={cn(CONTROL_CLASS, props.className)} />;
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
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger className={cn(CONTROL_CLASS, "flex items-center justify-between gap-2 text-left")}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={15} className="text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={14} className="text-accent" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
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
      <SwitchPrimitive.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 shrink-0 rounded-full border border-border bg-surface-2 transition data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4" />
      </SwitchPrimitive.Root>
      {label && <span className="text-sm">{label}</span>}
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
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onValueChange(next ?? min)}
        className="relative flex h-5 flex-1 touch-none select-none items-center"
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-surface-2">
          <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border-2 border-accent bg-surface shadow outline-none focus:ring-2 focus:ring-accent/30" />
      </SliderPrimitive.Root>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

export function Button({
  variant = "default",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
}) {
  const variants = {
    default: "border border-border bg-surface-2 hover:bg-border",
    primary: "bg-accent text-accent-fg hover:opacity-90",
    danger: "border border-border text-danger hover:bg-danger/10",
    ghost: "hover:bg-surface-2",
  };
  const sizes = { sm: "px-2.5 py-1 text-xs", md: "px-3 py-2 text-sm", lg: "px-5 py-3 text-base font-medium" };

  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
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
        className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-surface-2 p-1"
      />
      <TextInput value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs, dialog, feedback
// ---------------------------------------------------------------------------

export const Tabs = TabsPrimitive.Root;

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <TabsPrimitive.List className="scroll-x mb-4 flex gap-1 rounded-lg border border-border bg-surface-2 p-1">
      {children}
    </TabsPrimitive.List>
  );
}

export function TabTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted transition data-[state=active]:bg-surface data-[state=active]:text-text data-[state=active]:shadow-sm"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export const TabContent = TabsPrimitive.Content;

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
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(92vw,760px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-surface p-5 shadow-xl">
          <div className="mb-3 flex items-start justify-between gap-4">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={16} />
              </Button>
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  const tones = {
    info: "border-border bg-surface-2 text-text",
    success: "border-success/40 bg-success/10 text-success",
    warning: "border-warning/40 bg-warning/10 text-warning",
    danger: "border-danger/40 bg-danger/10 text-danger",
  };
  return <div className={cn("rounded-lg border px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "success" | "warning" | "danger" | "accent"; children: ReactNode }) {
  const tones = {
    muted: "bg-surface-2 text-muted",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
    accent: "bg-accent/15 text-accent",
  };
  return <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}
