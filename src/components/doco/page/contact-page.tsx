"use client";

import { useId, useRef, useState } from "react";
import {
  BadgeCheck,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  Mail,
  MapPin,
  Send,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { useLocalizedRoutes } from "@/hooks/use-hash-route";

/**
 * Contact page (PRD §5.4): contact form (name, email, category, message +
 * consent + honeypot), support SLA, legal address and a success screen
 * with the ticket id returned by POST /api/contact.
 */

const CATEGORIES_FORM = [
  { value: "bug", key: "contact.catBug" },
  { value: "feature", key: "contact.catFeature" },
  { value: "billing", key: "contact.catBilling" },
  { value: "business", key: "contact.catBusiness" },
  { value: "legal", key: "contact.catLegal" },
  { value: "other", key: "contact.catOther" },
] as const;

export function ContactPage() {
  const { t } = useI18n();
  const routes = useLocalizedRoutes();
  const { toast } = useToast();
  const formId = useId();
  const honeypotRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState<string>("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const nameValid = name.trim().length >= 2;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  const messageValid = message.trim().length >= 10;
  const canSubmit =
    nameValid && emailValid && messageValid && consent && !submitting;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          category,
          message: message.trim(),
          consent: true,
          hp: honeypotRef.current?.value ?? "",
        }),
      });
      const data: { ok?: boolean; ticket?: string; error?: string } =
        await response.json().catch(() => ({}));

      if (response.ok && data.ok && data.ticket) {
        setTicket(data.ticket);
        window.scrollTo(0, 0);
      } else if (response.status === 429) {
        toast({
          title: t("contact.errRateTitle"),
          description: t("contact.errRateBody"),
        });
      } else {
        toast({
          title: t("contact.errSendTitle"),
          description: t("contact.errSendBody"),
        });
      }
    } catch {
      toast({
        title: t("contact.errSendTitle"),
        description: t("contact.errSendBody"),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (ticket) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 py-16 text-center sm:py-24">
        <span className="flex size-16 items-center justify-center rounded-full border border-success/30 bg-success/10">
          <CheckCircle2 className="size-8 text-success" aria-hidden="true" />
        </span>
        <h1 className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl">
          {t("contact.successTitle")}
        </h1>
        <p className="mt-3 max-w-md text-pretty text-muted-foreground">
          {t("contact.successBody")}
        </p>
        <div className="mt-6 flex items-center gap-2 rounded-card border border-border bg-surface px-4 py-3">
          <span className="text-sm text-muted-foreground">
            {t("contact.ticketLabel")}
          </span>
          <code className="rounded-chip bg-primary/10 px-2.5 py-1 text-sm font-bold tracking-wide text-primary">
            {ticket}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(ticket).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              });
            }}
            className="flex size-9 items-center justify-center rounded-btn text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-label={t("contact.copyTicket")}
          >
            {copied ? (
              <BadgeCheck className="size-4 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          {t("contact.successNote")}
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="cta" size="touch" className="rounded-btn">
            <a href={routes.tools}>{t("contact.backTools")}</a>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            onClick={() => {
              setTicket(null);
              setName("");
              setEmail("");
              setCategory("");
              setMessage("");
              setConsent(false);
            }}
          >
            {t("contact.sendAnother")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PageShell
      icon={Mail}
      badge={t("contact.badge")}
      title={t("contact.title")}
      lede={t("contact.lede")}
      wide
    >
      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${formId}-name`}>{t("contact.nameLabel")}</Label>
              <Input
                id={`${formId}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("contact.namePlaceholder")}
                autoComplete="name"
                required
                aria-invalid={name.length > 0 && !nameValid}
                className="rounded-btn"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${formId}-email`}>
                {t("contact.emailLabel")}
              </Label>
              <Input
                id={`${formId}-email`}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t("contact.emailPlaceholder")}
                autoComplete="email"
                required
                aria-invalid={email.length > 0 && !emailValid}
                className="rounded-btn"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("contact.categoryLabel")}</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-12 w-full rounded-btn">
                <SelectValue placeholder={t("contact.categoryPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES_FORM.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("contact.categoryHint")}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${formId}-message`}>
              {t("contact.messageLabel")}
            </Label>
            <Textarea
              id={`${formId}-message`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("contact.messagePlaceholder")}
              rows={6}
              maxLength={5000}
              required
              aria-invalid={message.length > 0 && !messageValid}
              className="rounded-btn"
            />
            <p className="text-xs text-muted-foreground">
              {t("contact.messageHint", {
                count: message.length,
                max: 5000,
              })}
            </p>
          </div>

          <div className="flex items-start gap-3">
            <Checkbox
              id={`${formId}-consent`}
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
              className="mt-0.5"
            />
            <Label
              htmlFor={`${formId}-consent`}
              className="text-sm font-normal leading-relaxed text-muted-foreground"
            >
              {t("contact.consentLabel")}
            </Label>
          </div>

          {/* Honeypot — bots fill it, humans never see it. */}
          <div
            aria-hidden="true"
            className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
          >
            <label htmlFor={`${formId}-hp`}>Company</label>
            <input
              ref={honeypotRef}
              id={`${formId}-hp`}
              type="text"
              name="company_website"
              tabIndex={-1}
              autoComplete="off"
            />
          </div>

          <Button
            type="submit"
            variant="cta"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                {t("contact.sending")}
              </>
            ) : (
              <>
                <Send className="size-4" aria-hidden="true" />
                {t("contact.submit")}
              </>
            )}
          </Button>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck
              className="size-3.5 shrink-0 text-success"
              aria-hidden="true"
            />
            {t("contact.spamNote")}
          </p>
        </form>

        <aside className="space-y-4 lg:pt-0">
          <div className="rounded-card border border-border bg-surface p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Clock className="size-4 text-primary" aria-hidden="true" />
              {t("contact.slaTitle")}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("contact.slaBody")}
            </p>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Mail className="size-4 text-primary" aria-hidden="true" />
              {t("contact.emailTitle")}
            </p>
            <a
              href="mailto:support@docopdf.com"
              className="mt-1.5 block break-all text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-btn"
            >
              support@docopdf.com
            </a>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("contact.emailNote")}
            </p>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="size-4 text-primary" aria-hidden="true" />
              {t("contact.officeTitle")}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("contact.officeBody")}
            </p>
          </div>
          <div className="rounded-card border border-border bg-surface p-4">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck
                className="size-4 text-success"
                aria-hidden="true"
              />
              {t("contact.privacyTitle")}
            </p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("contact.privacyBody")}
            </p>
            <a
              href={routes.page("privacy")}
              className="mt-2 inline-flex min-h-11 items-center rounded-btn text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t("contact.privacyLink")}
            </a>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
