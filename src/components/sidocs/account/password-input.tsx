"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/providers/locale-provider";

interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  /** Marks the field invalid when an inline error is showing. */
  ariaInvalid?: boolean;
  disabled?: boolean;
}

/**
 * Password field with a show/hide toggle (Eye / EyeOff lucide icons).
 * The toggle is a 36px icon button inside the input's hit area with a
 * localized aria-label (reuses the existing dsig.pwShow/pwHide keys).
 */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  placeholder,
  maxLength,
  ariaInvalid,
  disabled,
}: PasswordInputProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        className="pr-12"
      />
      <button
        type="button"
        onClick={() => setShow((visible) => !visible)}
        aria-label={show ? t("dsig.pwHide") : t("dsig.pwShow")}
        aria-pressed={show}
        className="absolute right-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {show ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
