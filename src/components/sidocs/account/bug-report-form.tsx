"use client";

import { useMemo, useState } from "react";
import { Loader2, Megaphone, Send } from "lucide-react";

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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { submitBugReport, type BugCategory, type BugSeverity } from "./api";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { ALL_TOOLS } from "@/lib/tools/registry";

const CATEGORIES: BugCategory[] = ["bug", "feature", "other"];
const SEVERITIES: BugSeverity[] = ["low", "medium", "high", "critical"];
const NO_TOOL = "none";

/**
 * Bug report form (account view, works signed-out too). Category is a
 * segmented control (Tabs), severity + related tool are Selects populated
 * from the live tool registry, and the contact email is prefilled from the
 * signed-in account (locked — admins reply to the account email) or free
 * to type when reporting anonymously.
 */
export function BugReportForm({ userEmail }: { userEmail: string | null }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();

  const [category, setCategory] = useState<BugCategory>("bug");
  const [severity, setSeverity] = useState<BugSeverity>("medium");
  const [toolId, setToolId] = useState<string>(NO_TOOL);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const enabledTools = useMemo(
    () => ALL_TOOLS.filter((tool) => tool.enabled),
    []
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmedTitle = title.trim();
    const trimmedMessage = message.trim();
    if (!trimmedTitle || !trimmedMessage) {
      setError(true);
      return;
    }
    setBusy(true);
    setError(false);
    const res = await submitBugReport({
      title: trimmedTitle.slice(0, 120),
      message: trimmedMessage.slice(0, 2000),
      category,
      severity,
      toolId: toolId === NO_TOOL ? undefined : toolId,
      email: userEmail ?? (email.trim() || undefined),
    });
    setBusy(false);
    if (res.ok) {
      setTitle("");
      setMessage("");
      setCategory("bug");
      setSeverity("medium");
      setToolId(NO_TOOL);
      toast({ title: t("bugs.submitted") });
      // My Reports listens and refetches (house custom-event pattern).
      window.dispatchEvent(new Event("sidocs:bug-reported"));
      return;
    }
    setError(true);
  };

  return (
    <section
      aria-labelledby="bug-report-heading"
      className="rounded-card border border-border bg-card"
    >
      <div className="border-b border-border p-5 pb-4">
        <h2
          id="bug-report-heading"
          className="flex items-center gap-2 text-base font-semibold text-foreground"
        >
          <Megaphone className="size-4 text-primary" aria-hidden="true" />
          {t("bugs.title")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("account.bugHint")}
        </p>
      </div>

      <form noValidate onSubmit={submit} className="space-y-4 p-5">
        <div className="space-y-2">
          <Label id="bug-category-label">{t("bugs.categoryLabel")}</Label>
          <Tabs
            value={category}
            onValueChange={(value) => setCategory(value as BugCategory)}
          >
            <TabsList
              aria-labelledby="bug-category-label"
              className="grid h-11 w-full grid-cols-3 rounded-btn"
            >
              {CATEGORIES.map((item) => (
                <TabsTrigger
                  key={item}
                  value={item}
                  className="rounded-btn text-xs sm:text-sm"
                >
                  {t(`bugs.category.${item}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="bug-severity">{t("bugs.severityLabel")}</Label>
            <Select value={severity} onValueChange={(value) => setSeverity(value as BugSeverity)}>
              <SelectTrigger id="bug-severity" className="w-full rounded-btn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`bugs.severity.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="bug-tool">{t("bugs.toolLabel")}</Label>
            <Select value={toolId} onValueChange={setToolId}>
              <SelectTrigger id="bug-tool" className="w-full rounded-btn">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={NO_TOOL}>
                  {t("bugs.tool.none")}
                </SelectItem>
                {enabledTools.map((tool) => (
                  <SelectItem key={tool.id} value={tool.id}>
                    {tool.name[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="bug-title">{t("bugs.subject")}</Label>
          <Input
            id="bug-title"
            value={title}
            maxLength={120}
            placeholder={t("bugs.subjectPlaceholder")}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bug-details">{t("bugs.details")}</Label>
          <Textarea
            id="bug-details"
            value={message}
            rows={4}
            maxLength={2000}
            placeholder={t("bugs.detailsPlaceholder")}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="bug-email">{t("bugs.emailOptional")}</Label>
          <Input
            id="bug-email"
            type="email"
            inputMode="email"
            value={userEmail ?? email}
            autoComplete="email"
            disabled={userEmail !== null}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {t("bugs.error")}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="cta"
          size="touch"
          disabled={busy}
          className="w-full rounded-btn font-semibold sm:w-auto"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
          {t("bugs.submit")}
        </Button>
      </form>
    </section>
  );
}
