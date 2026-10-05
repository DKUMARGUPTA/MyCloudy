"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/components/providers/locale-provider";
import type { OptionField, OptionValues } from "@/lib/tools/config-types";
import { cn } from "@/lib/utils";

/**
 * OptionsPanel (PRD §6.3 workspace): renders a tool's option schema.
 * Every control is labeled, keyboard-reachable and 44px-touch friendly.
 */

export function OptionsPanel({
  fields,
  values,
  onChange,
  className,
}: {
  fields: OptionField[];
  values: OptionValues;
  onChange: (id: string, value: string | number | boolean) => void;
  className?: string;
}) {
  const { t, locale } = useI18n();

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {fields.map((field) => {
        const value = values[field.id];
        const hint = field.hint ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {field.hint[locale]}
          </p>
        ) : null;

        if (field.kind === "select") {
          return (
            <div key={field.id} className="flex flex-col gap-1.5">
              <Label htmlFor={`opt-${field.id}`} className="text-sm font-medium">
                {field.label[locale]}
              </Label>
              <Select
                value={String(value ?? field.default)}
                onValueChange={(next) => onChange(field.id, next)}
              >
                <SelectTrigger
                  id={`opt-${field.id}`}
                  className="h-11 w-full rounded-btn"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {hint}
            </div>
          );
        }

        if (field.kind === "number") {
          return (
            <div key={field.id} className="flex flex-col gap-1.5">
              <Label htmlFor={`opt-${field.id}`} className="text-sm font-medium">
                {field.label[locale]}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`opt-${field.id}`}
                  type="number"
                  inputMode="numeric"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 1}
                  value={Number(value ?? field.default)}
                  onChange={(event) => onChange(field.id, event.target.valueAsNumber)}
                  className="h-11 rounded-btn"
                />
                {field.suffix ? (
                  <span className="text-xs text-muted-foreground">
                    {field.suffix[locale]}
                  </span>
                ) : null}
              </div>
              {hint}
            </div>
          );
        }

        if (field.kind === "switch") {
          const checked = Boolean(value ?? field.default);
          return (
            <div key={field.id} className="flex items-center justify-between gap-3">
              <Label htmlFor={`opt-${field.id}`} className="text-sm font-medium">
                {field.label[locale]}
              </Label>
              <Switch
                id={`opt-${field.id}`}
                checked={checked}
                onCheckedChange={(next) => onChange(field.id, next)}
                aria-label={field.label[locale]}
              />
              {hint}
            </div>
          );
        }

        // text | pages
        return (
          <div key={field.id} className="flex flex-col gap-1.5">
            <Label htmlFor={`opt-${field.id}`} className="text-sm font-medium">
              {field.label[locale]}
              {field.kind === "pages" ? (
                <span className="ml-1.5 rounded-chip bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {t("tool.pagesFieldBadge")}
                </span>
              ) : null}
            </Label>
            <Input
              id={`opt-${field.id}`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder={field.placeholder ? field.placeholder[locale] : undefined}
              value={String(value ?? field.default)}
              onChange={(event) => onChange(field.id, event.target.value)}
              className="h-11 rounded-btn font-medium"
            />
            {hint}
          </div>
        );
      })}
    </div>
  );
}
