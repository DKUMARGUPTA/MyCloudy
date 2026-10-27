"use client";

import { useState, type FormEvent } from "react";
import { BadgeCheck, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/components/providers/locale-provider";
import { ROUTES } from "@/hooks/use-hash-route";
import { cn } from "@/lib/utils";

/**
 * Contact form (Phase 6). Client-side validation mirrors the zod schema
 * in /api/contact: name 2–80, email, category enum, message 10–1500 and
 * an invisible honeypot that humans never fill. POSTs to the relative
 * /api/contact path — the sandbox gateway forwards it as-is.
 */

const CATEGORIES = ["bug", "idea", "question", "other"] as const;
type Category = (typeof CATEGORIES)[number];

const MESSAGE_MAX = 1500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "success" }
  | { state: "error"; reason: string };

export function ContactForm() {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState<Category>("bug");
  const [message, setMessage] = useState("");
  const [hp, setHp] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [touched, setTouched] = useState(false);

  const nameError = touched && name.trim().length < 2;
  const emailError = touched && !EMAIL_RE.test(email.trim());
  const messageError = touched && message.trim().length < 10;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (
      name.trim().length < 2 ||
      !EMAIL_RE.test(email.trim()) ||
      message.trim().length < 10
    ) {
      return;
    }
    setStatus({ state: "sending" });
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          category,
          message: message.trim(),
          hp,
        }),
      });
      if (response.ok) {
        setStatus({ state: "success" });
        return;
      }
      setStatus({
        state: "error",
        reason:
          response.status === 429
            ? t("legal.contact.errRate")
            : t("legal.contact.errorBody"),
      });
    } catch {
      setStatus({
        state: "error",
        reason: t("legal.contact.errorBody"),
      });
    }
  }

  function reset() {
    setName("");
    setEmail("");
    setCategory("bug");
    setMessage("");
    setHp("");
    setTouched(false);
    setStatus({ state: "idle" });
  }

  if (status.state === "success") {
    return (
      <div
        className="rounded-card border border-success/30 bg-success/5 p-8 text-center"
        role="status"
      >
        <div
          className="mx-auto flex size-12 items-center justify-center rounded-btn bg-success/10 text-success"
          aria-hidden="true"
        >
          <BadgeCheck className="size-6" />
        </div>
        <h3 className="mt-4 text-lg font-semibold">
          {t("legal.contact.successTitle")}
        </h3>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          {t("legal.contact.successBody")}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-6 min-h-11 rounded-btn"
          onClick={reset}
        >
          {t("legal.contact.sendAnother")}
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="rounded-card border border-border bg-card p-6 shadow-xs sm:p-8"
      aria-label={t("legal.contact.formTitle")}
    >
      <h2 className="text-lg font-semibold">
        {t("legal.contact.formTitle")}
      </h2>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="contact-name">{t("legal.contact.nameLabel")}</Label>
          <Input
            id="contact-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("legal.contact.namePlaceholder")}
            maxLength={80}
            autoComplete="name"
            required
            aria-invalid={nameError}
            aria-describedby={nameError ? "contact-name-error" : undefined}
            className={cn(
              "min-h-11",
              nameError && "border-destructive focus-visible:ring-destructive/30"
            )}
          />
          {nameError ? (
            <p
              id="contact-name-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {t("legal.contact.errName")}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="contact-email">{t("legal.contact.emailLabel")}</Label>
          <Input
            id="contact-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("legal.contact.emailPlaceholder")}
            maxLength={120}
            autoComplete="email"
            required
            aria-invalid={emailError}
            aria-describedby={emailError ? "contact-email-error" : undefined}
            className={cn(
              "min-h-11",
              emailError && "border-destructive focus-visible:ring-destructive/30"
            )}
          />
          {emailError ? (
            <p
              id="contact-email-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {t("legal.contact.errEmail")}
            </p>
          ) : null}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="contact-category">
            {t("legal.contact.categoryLabel")}
          </Label>
          <Select
            value={category}
            onValueChange={(value: string) => {
              if (CATEGORIES.includes(value as Category)) {
                setCategory(value as Category);
              }
            }}
          >
            <SelectTrigger
              id="contact-category"
              className="min-h-11 w-full rounded-btn"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((item) => (
                <SelectItem key={item} value={item} className="py-2">
                  {t(`legal.contact.categories.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="contact-message">
            {t("legal.contact.messageLabel")}
          </Label>
          <Textarea
            id="contact-message"
            value={message}
            onChange={(event) =>
              setMessage(event.target.value.slice(0, MESSAGE_MAX))
            }
            placeholder={t("legal.contact.messagePlaceholder")}
            rows={6}
            maxLength={MESSAGE_MAX}
            required
            aria-invalid={messageError}
            aria-describedby="contact-message-hint"
            className={cn(
              "min-h-28",
              messageError && "border-destructive focus-visible:ring-destructive/30"
            )}
          />
          <div className="flex items-start justify-between gap-4">
            <p
              id="contact-message-hint"
              className={cn(
                "text-xs",
                messageError ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {messageError
                ? t("legal.contact.errMessage")
                : t("legal.contact.messageHint", {
                    count: message.length,
                    max: MESSAGE_MAX,
                  })}
            </p>
          </div>
        </div>
      </div>

      {/* Honeypot — invisible to humans, bots fill it and get rejected. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0">
        <label htmlFor="contact-hp">Website</label>
        <input
          id="contact-hp"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={hp}
          onChange={(event) => setHp(event.target.value)}
        />
      </div>

      {status.state === "error" ? (
        <p
          role="alert"
          className="mt-4 rounded-btn border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {status.reason}
        </p>
      ) : null}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-sm text-xs text-muted-foreground">
          {t("legal.contact.formNote")}{" "}
          <a
            href={ROUTES.page("privacy")}
            className="font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("legal.nav.privacy")}
          </a>
        </p>
        <Button
          type="submit"
          variant="cta"
          size="touch"
          disabled={status.state === "sending"}
          className="min-h-11 rounded-btn"
        >
          {status.state === "sending" ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("legal.contact.submitting")}
            </>
          ) : (
            <>
              <Send className="size-4" aria-hidden="true" />
              {t("legal.contact.submit")}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
