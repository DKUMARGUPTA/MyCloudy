"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Calculator,
  ChevronDown,
  Clock3,
  FileDown,
  Landmark,
  ListTree,
  Loader2,
  LogIn,
  Plus,
  ReceiptText,
  RefreshCw,
  Scale,
  ShieldAlert,
  Trash2,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/doco/empty-state";
import { Modal } from "@/components/doco/modal";
import { PageShell } from "@/components/doco/page/page-shell";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics/ga4";
import { cn } from "@/lib/utils";
import { openAuthModal, useAuth } from "@/lib/auth-client";
import {
  fetchAccounts,
  fetchInvoices,
  fetchJournal,
  fetchOverview,
  fetchReport,
  postManualEntry,
  runSync,
  type AccountDto,
  type BalanceSheetDto,
  type GstDto,
  type InvoiceDto,
  type JournalEntryDto,
  type OverviewDto,
  type PnlDto,
  type TrialBalanceDto,
} from "@/lib/accounting-client";

/**
 * AccountingPage (R27) — the admin console for the DocoPDF books:
 * double-entry journal, chart of accounts, GST invoices and the standard
 * report set. Admins reach it from the account menu; non-admins get the
 * honest not-authorized panel (the APIs re-check the role anyway).
 */

const PAGE_SIZE = 15;

function fmtInr(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtUsd(minor: number): string {
  return `$${(minor / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale === "hi" ? "hi-IN" : "en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function AccountingPage() {
  const { t, locale } = useI18n();
  const { user, status } = useAuth();

  useEffect(() => {
    if (user?.role === "admin") track("accounting_view", { locale });
  }, [user, locale]);

  if (status === "loading") {
    return (
      <div className="mx-auto flex w-full max-w-6xl items-center justify-center gap-2 px-4 py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">{t("account.loading")}</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<LogIn />}
          title={t("accounting.signInTitle")}
          description={t("accounting.signInDesc")}
          action={
            <Button
              type="button"
              size="touch"
              className="rounded-btn"
              onClick={() => openAuthModal("login")}
            >
              {t("auth.tabLogin")}
            </Button>
          }
        />
      </div>
    );
  }

  if (user.role !== "admin") {
    return (
      <div className="mx-auto flex w-full max-w-xl justify-center px-4 py-20">
        <EmptyState
          icon={<ShieldAlert />}
          title={t("accounting.forbiddenTitle")}
          description={t("accounting.forbiddenDesc")}
        />
      </div>
    );
  }

  return (
    <PageShell
      icon={BookOpenCheck}
      badge={t("accounting.badge")}
      title={t("accounting.title")}
      lede={t("accounting.lede")}
      wide
    >
      <Console />
    </PageShell>
  );
}

/* ------------------------------------------------------------------ */
/* Console shell — sync button + tabs                                  */
/* ------------------------------------------------------------------ */

function Console() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchOverview().then((data) => {
      if (active) setOverview(data);
    });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    const result = await runSync();
    setSyncing(false);
    if (!result) {
      toast({ title: t("accounting.sync.failed"), variant: "destructive" });
      return;
    }
    track("accounting_sync", { posted: result.paymentsPosted });
    toast({
      title: t("accounting.sync.done"),
      description: t("accounting.sync.result", {
        payments: result.paymentsPosted,
        invoices: result.invoicesIssued,
        recognized: result.recognitionEntries,
      }),
    });
    setReloadKey((key) => key + 1);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {overview?.metrics.lastEntryAt
            ? t("accounting.lastEntry", {
                count: overview.metrics.entryCount,
              })
            : t("accounting.noEntries")}
        </p>
        <Button
          type="button"
          size="touch"
          className="rounded-btn"
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          {syncing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="size-4" aria-hidden="true" />
          )}
          {syncing ? t("accounting.sync.running") : t("accounting.sync.cta")}
        </Button>
      </div>

      <Tabs defaultValue="overview" className="gap-6">
        <TabsList className="h-auto w-full justify-start overflow-x-auto rounded-card p-1">
          <TabsTrigger value="overview" className="gap-1.5 rounded-btn">
            <TrendingUp className="size-4" aria-hidden="true" />
            {t("accounting.tab.overview")}
          </TabsTrigger>
          <TabsTrigger value="journal" className="gap-1.5 rounded-btn">
            <ListTree className="size-4" aria-hidden="true" />
            {t("accounting.tab.journal")}
          </TabsTrigger>
          <TabsTrigger value="accounts" className="gap-1.5 rounded-btn">
            <Landmark className="size-4" aria-hidden="true" />
            {t("accounting.tab.accounts")}
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-1.5 rounded-btn">
            <ReceiptText className="size-4" aria-hidden="true" />
            {t("accounting.tab.invoices")}
          </TabsTrigger>
          <TabsTrigger value="reports" className="gap-1.5 rounded-btn">
            <Calculator className="size-4" aria-hidden="true" />
            {t("accounting.tab.reports")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab overview={overview} />
        </TabsContent>
        <TabsContent value="journal">
          <JournalTab onPosted={() => setReloadKey((key) => key + 1)} />
        </TabsContent>
        <TabsContent value="accounts">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="invoices">
          <InvoicesTab />
        </TabsContent>
        <TabsContent value="reports">
          <ReportsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tab                                                        */
/* ------------------------------------------------------------------ */

/** KPI tile (R46 polish) — same visual language as the admin StatCard:
 *  tone-tinted top accent, hover lift, icon micro-interaction. */
function KpiCard({
  label,
  value,
  icon: Icon,
  tone = "primary",
}: {
  label: string;
  value: string;
  icon: typeof Wallet;
  tone?: "primary" | "accent" | "success" | "muted";
}) {
  const tones: Record<string, string> = {
    primary: "border-primary/20 bg-primary/5 text-primary",
    accent: "border-cat-optimize/25 bg-cat-optimize/10 text-cat-optimize",
    success: "border-success/30 bg-success/10 text-success",
    muted: "border-border bg-muted/50 text-muted-foreground",
  };
  const accents: Record<string, string> = {
    primary: "from-primary/50",
    accent: "from-cat-optimize/50",
    success: "from-success/50",
    muted: "from-muted-foreground/40",
  };
  return (
    <div className="group relative overflow-hidden rounded-card border border-border bg-surface outline-none transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <span
        className={cn(
          "absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent",
          accents[tone]
        )}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-2 p-4">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground">
            {label}
          </p>
          <p className="mt-1.5 truncate text-xl font-bold tabular-nums text-foreground">
            {value}
          </p>
        </div>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border transition-transform duration-200 group-hover:scale-110",
            tones[tone]
          )}
          aria-hidden="true"
        >
          <Icon className="size-4" />
        </span>
      </div>
    </div>
  );
}

function OverviewTab({ overview }: { overview: OverviewDto | null }) {
  const { t, locale } = useI18n();

  if (!overview) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-card" />
        ))}
      </div>
    );
  }

  const m = overview.metrics;
  const stats = [
    { label: t("accounting.overview.cashInr"), value: fmtInr(m.cashCollectedInr), icon: Wallet, tone: "primary" as const },
    { label: t("accounting.overview.cashUsd"), value: fmtUsd(m.cashCollectedUsd), icon: Wallet, tone: "primary" as const },
    { label: t("accounting.overview.recognized"), value: fmtInr(m.recognizedRevenue), icon: TrendingUp, tone: "success" as const },
    { label: t("accounting.overview.deferred"), value: fmtInr(m.deferredBalance), icon: Clock3, tone: "muted" as const },
    { label: t("accounting.overview.gstPayable"), value: fmtInr(m.gstPayable), icon: Landmark, tone: "accent" as const },
    { label: t("accounting.overview.mrr"), value: fmtInr(m.mrrInr), icon: TrendingUp, tone: "success" as const },
    { label: t("accounting.overview.activeSubs"), value: String(m.activeSubscriptions), icon: ReceiptText, tone: "muted" as const },
    { label: t("accounting.overview.proUsers"), value: String(m.proUsers), icon: BookOpenCheck, tone: "accent" as const },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <KpiCard key={stat.label} {...stat} />
        ))}
      </div>

      <Card className="rounded-card">
        <CardHeader>
          <CardTitle className="text-base">{t("accounting.overview.recent")}</CardTitle>
          <CardDescription>{t("accounting.overview.recentDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.recentEntries.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{t("accounting.recentEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {overview.recentEntries.map((entry) => (
                <li key={entry.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{entry.memo}</p>
                    <Badge variant="secondary" className="rounded-chip">
                      {t(`accounting.source.${entry.source}` as never)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.entryNo} · {fmtDate(entry.date, locale)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    {entry.lines.map((line, i) => (
                      <span key={i} className="text-xs text-muted-foreground">
                        {line.code} ·{" "}
                        <span className={line.debit > 0 ? "font-medium text-foreground" : ""}>
                          {line.debit > 0 ? `Dr ${fmtInr(line.debit)}` : ""}
                        </span>
                        {line.credit > 0 ? (
                          <span className="font-medium text-foreground">Cr {fmtInr(line.credit)}</span>
                        ) : null}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Journal tab                                                         */
/* ------------------------------------------------------------------ */

function JournalTab({ onPosted }: { onPosted: () => void }) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<JournalEntryDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetchJournal(PAGE_SIZE, offset).then((data) => {
      if (!active) return;
      if (data) {
        setEntries(data.entries);
        setTotal(data.total);
      } else {
        setEntries([]);
      }
    });
    return () => {
      active = false;
    };
  }, [offset, reloadKey]);

  const page = offset / PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("accounting.journal.desc")}</p>
        <Button
          type="button"
          size="touch"
          variant="outline"
          className="rounded-btn"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("accounting.journal.new")}
        </Button>
      </div>

      <Card className="rounded-card">
        <CardContent className="p-0">
          {entries === null ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 rounded-card" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t("accounting.journal.empty")}
            </p>
          ) : (
            <ScrollArea className="max-h-[28rem]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accounting.journal.entryNo")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("accounting.journal.date")}</TableHead>
                    <TableHead>{t("accounting.journal.memo")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("accounting.journal.source")}</TableHead>
                    <TableHead className="text-right">{t("accounting.journal.debit")}</TableHead>
                    <TableHead className="text-right">{t("accounting.journal.credit")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const sumDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
                    const expanded = expandedId === entry.id;
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => setExpandedId(expanded ? null : entry.id)}
                          aria-expanded={expanded}
                        >
                          <TableCell className="whitespace-nowrap font-medium">
                            <span className="inline-flex items-center gap-1">
                              <ChevronDown
                                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
                                aria-hidden="true"
                              />
                              {entry.entryNo}
                            </span>
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                            {fmtDate(entry.date, locale)}
                          </TableCell>
                          <TableCell>
                            <span className="line-clamp-2 max-w-[16rem]">{entry.memo}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
                              {t(`accounting.source.${entry.source}` as never)}
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <Badge variant="outline" className="rounded-chip">
                              {t(`accounting.source.${entry.source}` as never)}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            {fmtInr(sumDebit)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            {fmtInr(sumDebit)}
                          </TableCell>
                        </TableRow>
                        {expanded ? (
                          <TableRow>
                            <TableCell colSpan={6} className="bg-muted/40 px-4 py-2">
                              <ul className="flex flex-col gap-1">
                                {entry.lines.map((line, i) => (
                                  <li
                                    key={i}
                                    className="flex flex-wrap items-center justify-between gap-2 text-xs"
                                  >
                                    <span className="font-medium text-foreground">
                                      {line.code} · {line.name}
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                      {line.debit > 0
                                        ? `Dr ${fmtInr(line.debit)}`
                                        : `Cr ${fmtInr(line.credit)}`}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            disabled={page === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("accounting.prev")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("accounting.page", { current: page + 1, total: pageCount })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            disabled={page + 1 >= pageCount}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t("accounting.next")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <ManualEntryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onPosted={() => {
          setReloadKey((key) => key + 1);
          onPosted();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Manual entry dialog                                                 */
/* ------------------------------------------------------------------ */

interface LineDraft {
  code: string;
  debit: string;
  credit: string;
}

function ManualEntryDialog({
  open,
  onOpenChange,
  onPosted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPosted: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [date, setDate] = useState(todayISO());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    { code: "", debit: "", credit: "" },
    { code: "", debit: "", credit: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void fetchAccounts().then((data) => {
      if (data) setAccounts(data.accounts);
    });
  }, [open]);

  const sums = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      debit += Math.round((Number(line.debit) || 0) * 100);
      credit += Math.round((Number(line.credit) || 0) * 100);
    }
    return { debit, credit, balanced: debit > 0 && debit === credit };
  }, [lines]);

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (!memo.trim() || lines.some((l) => !l.code)) {
      setError(t("accounting.journal.errFields"));
      return;
    }
    if (!sums.balanced) {
      setError(t("accounting.journal.unbalanced"));
      return;
    }

    setBusy(true);
    const res = await postManualEntry({
      date,
      memo: memo.trim(),
      lines: lines
        .filter((l) => l.code && (Number(l.debit) > 0 || Number(l.credit) > 0))
        .map((l) => ({
          code: l.code,
          debit: l.debit ? Math.round(Number(l.debit) * 100) : undefined,
          credit: l.credit ? Math.round(Number(l.credit) * 100) : undefined,
        })),
    });
    setBusy(false);

    if (res.ok) {
      track("accounting_manual_entry");
      toast({ title: t("accounting.journal.posted", { no: res.entryNo ?? "" }) });
      setMemo("");
      setLines([
        { code: "", debit: "", credit: "" },
        { code: "", debit: "", credit: "" },
      ]);
      onOpenChange(false);
      onPosted();
      return;
    }
    setError(res.message ?? t(`billing.err.${res.error ?? "server_error"}` as never));
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("accounting.journal.newTitle")}
      description={t("accounting.journal.newDesc")}
      contentClassName="sm:max-w-2xl"
      footer={
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <div className="mr-auto flex items-center gap-2 text-xs">
            <span className={sums.balanced ? "font-medium text-success" : "font-medium text-destructive"}>
              {t("accounting.journal.debit")} {fmtInr(sums.debit)} · {t("accounting.journal.credit")}{" "}
              {fmtInr(sums.credit)}
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="touch"
            className="rounded-btn"
            disabled={busy || !sums.balanced}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("accounting.journal.submit")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <Label htmlFor="je-date">{t("accounting.journal.date")}</Label>
            <Input
              id="je-date"
              type="date"
              value={date}
              max={todayISO()}
              onChange={(e) => setDate(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="je-memo">{t("accounting.journal.memo")}</Label>
            <Input
              id="je-memo"
              value={memo}
              maxLength={300}
              placeholder={t("accounting.journal.memoPlaceholder")}
              onChange={(e) => setMemo(e.target.value)}
              disabled={busy}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,5.5rem)_minmax(0,5.5rem)_2.25rem] items-end gap-2"
            >
              <div className="flex flex-col gap-1.5">
                <Label className="sr-only" htmlFor={`je-code-${index}`}>
                  {t("accounting.journal.account")}
                </Label>
                <Select
                  value={line.code}
                  onValueChange={(value) => updateLine(index, { code: value })}
                >
                  <SelectTrigger id={`je-code-${index}`} className="w-full rounded-btn">
                    <SelectValue placeholder={t("accounting.journal.account")} />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.code} value={account.code}>
                        {account.code} · {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="sr-only" htmlFor={`je-debit-${index}`}>
                  {t("accounting.journal.debit")}
                </Label>
                <Input
                  id={`je-debit-${index}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t("accounting.journal.debit")}
                  value={line.debit}
                  onChange={(e) => updateLine(index, { debit: e.target.value, credit: "" })}
                  disabled={busy}
                  className="rounded-btn tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="sr-only" htmlFor={`je-credit-${index}`}>
                  {t("accounting.journal.credit")}
                </Label>
                <Input
                  id={`je-credit-${index}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t("accounting.journal.credit")}
                  value={line.credit}
                  onChange={(e) => updateLine(index, { credit: e.target.value, debit: "" })}
                  disabled={busy}
                  className="rounded-btn tabular-nums"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="rounded-btn text-muted-foreground hover:text-destructive"
                disabled={busy || lines.length <= 2}
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                aria-label={t("accounting.journal.removeLine")}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-full rounded-btn sm:w-auto"
            disabled={busy || lines.length >= 12}
            onClick={() =>
              setLines((prev) => [...prev, { code: "", debit: "", credit: "" }])
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("accounting.journal.addLine")}
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Accounts tab                                                        */
/* ------------------------------------------------------------------ */

const TYPE_BADGE: Record<string, { variant: "default" | "secondary" | "outline" | "new" | "destructive"; key: string }> = {
  asset: { variant: "new", key: "accounting.type.asset" },
  liability: { variant: "secondary", key: "accounting.type.liability" },
  equity: { variant: "outline", key: "accounting.type.equity" },
  revenue: { variant: "default", key: "accounting.type.revenue" },
  expense: { variant: "destructive", key: "accounting.type.expense" },
};

function AccountsTab() {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<AccountDto[] | null>(null);

  useEffect(() => {
    void fetchAccounts().then((data) => setAccounts(data ? data.accounts : []));
  }, []);

  if (accounts === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 rounded-card" />
        ))}
      </div>
    );
  }

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="text-base">{t("accounting.accounts.title")}</CardTitle>
        <CardDescription>{t("accounting.accounts.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[30rem]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.accounts.code")}</TableHead>
                <TableHead>{t("accounting.accounts.name")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("accounting.accounts.type")}</TableHead>
                <TableHead className="text-right">{t("accounting.accounts.balance")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => {
                const badge = TYPE_BADGE[account.type] ?? TYPE_BADGE.equity;
                return (
                  <TableRow key={account.id}>
                    <TableCell className="font-medium tabular-nums">{account.code}</TableCell>
                    <TableCell>{account.name}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant={badge.variant} className="rounded-chip">
                        {t(badge.key as never)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {fmtInr(account.balance)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Invoices tab                                                        */
/* ------------------------------------------------------------------ */

const TAX_TYPE_KEYS: Record<string, string> = {
  cgst_sgst: "accounting.taxtype.cgst_sgst",
  igst: "accounting.taxtype.igst",
  export: "accounting.taxtype.export",
};

const INVOICE_STATUS_KEYS: Record<string, { key: string; variant: "default" | "destructive" | "outline" }> = {
  paid: { key: "accounting.invstatus.paid", variant: "default" },
  refunded: { key: "accounting.invstatus.refunded", variant: "destructive" },
  void: { key: "accounting.invstatus.void", variant: "outline" },
};

function InvoicesTab() {
  const { t, locale } = useI18n();
  const [invoices, setInvoices] = useState<InvoiceDto[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    void fetchInvoices(PAGE_SIZE, offset).then((data) => {
      if (data) {
        setInvoices(data.invoices);
        setTotal(data.total);
      } else {
        setInvoices([]);
      }
    });
  }, [offset]);

  const page = offset / PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("accounting.invoices.desc")}</p>
        <a
          href="/api/admin/accounting/export?type=invoices"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-btn border border-border bg-surface px-4 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <FileDown className="size-4" aria-hidden="true" />
          {t("accounting.export.invoices")}
        </a>
      </div>

      <Card className="rounded-card">
        <CardContent className="p-0">
          {invoices === null ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-card" />
              ))}
            </div>
          ) : invoices.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {t("accounting.invoices.empty")}
            </p>
          ) : (
            <ScrollArea className="max-h-[30rem]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("accounting.invoices.invoiceNo")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("accounting.invoices.date")}</TableHead>
                    <TableHead>{t("accounting.invoices.customer")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("accounting.invoices.taxType")}</TableHead>
                    <TableHead className="text-right">{t("accounting.invoices.total")}</TableHead>
                    <TableHead className="text-right">{t("accounting.invoices.tax")}</TableHead>
                    <TableHead>{t("accounting.invoices.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => {
                    const status = INVOICE_STATUS_KEYS[inv.status] ?? INVOICE_STATUS_KEYS.paid;
                    return (
                      <TableRow key={inv.id}>
                        <TableCell className="whitespace-nowrap font-medium">{inv.invoiceNo}</TableCell>
                        <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                          {fmtDate(inv.issuedAt, locale)}
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-[12rem] truncate">{inv.customerEmail}</span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <Badge variant="outline" className="rounded-chip">
                            {t((TAX_TYPE_KEYS[inv.taxType] ?? TAX_TYPE_KEYS.cgst_sgst) as never)}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                          {inv.currency === "INR" ? fmtInr(inv.totalAmount) : fmtUsd(inv.totalAmount)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                          {inv.currency === "INR" ? fmtInr(inv.taxAmount) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={status.variant} className="rounded-chip">
                            {t(status.key as never)}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            disabled={page === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("accounting.prev")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("accounting.page", { current: page + 1, total: pageCount })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="rounded-btn"
            disabled={page + 1 >= pageCount}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t("accounting.next")}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports tab                                                         */
/* ------------------------------------------------------------------ */

type ReportKind = "trial_balance" | "pnl" | "balance_sheet" | "gst";

function ReportsTab() {
  const { t } = useI18n();
  const [kind, setKind] = useState<ReportKind>("trial_balance");
  const [from, setFrom] = useState(daysAgoISO(365));
  const [to, setTo] = useState(todayISO());
  /* The fetched result is TAGGED with the report kind it belongs to —
   * switching kinds must never render the previous report's shape
   * through the new view (that crash-landed the first cut: a stale
   * TrialBalanceDto hitting PnlView's data.revenue.map). */
  const [result, setResult] = useState<{ kind: ReportKind; data: unknown } | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const currentKind = kind;
    void fetchReport<unknown>(currentKind, from, to).then((data) => {
      if (!active) return;
      setResult({ kind: currentKind, data });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [kind, from, to, reloadKey]);

  const refresh = () => {
    setLoading(true);
    setResult(null);
    setReloadKey((key) => key + 1);
  };

  const ready = result !== null && result.kind === kind;

  return (
    <div className="space-y-4">
      <Card className="rounded-card">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex min-w-[11rem] flex-col gap-2">
            <Label htmlFor="report-kind">{t("accounting.reports.type")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ReportKind)}>
              <SelectTrigger id="report-kind" className="w-full rounded-btn">
                <SelectValue />
                <ChevronDown className="size-4" aria-hidden="true" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="trial_balance">{t("accounting.reports.trialBalance")}</SelectItem>
                <SelectItem value="pnl">{t("accounting.reports.pnl")}</SelectItem>
                <SelectItem value="balance_sheet">{t("accounting.reports.balanceSheet")}</SelectItem>
                <SelectItem value="gst">{t("accounting.reports.gst")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind !== "balance_sheet" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="report-from">{t("accounting.reports.from")}</Label>
                <Input
                  id="report-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="rounded-btn"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="report-to">{t("accounting.reports.to")}</Label>
                <Input
                  id="report-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="rounded-btn"
                />
              </div>
            </>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              size="touch"
              variant="outline"
              className="rounded-btn"
              disabled={loading}
              onClick={refresh}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-4" aria-hidden="true" />
              )}
              {t("accounting.reports.run")}
            </Button>
            <a
              href={`/api/admin/accounting/export?type=${kind === "balance_sheet" ? "trial_balance" : kind}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-btn border border-border bg-surface px-4 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <FileDown className="size-4" aria-hidden="true" />
              CSV
            </a>
          </div>
        </CardContent>
      </Card>

      {loading || !ready ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-card" />
          ))}
        </div>
      ) : kind === "trial_balance" ? (
        <TrialBalanceView data={result.data as TrialBalanceDto} />
      ) : kind === "pnl" ? (
        <PnlView data={result.data as PnlDto} />
      ) : kind === "balance_sheet" ? (
        <BalanceSheetView data={result.data as BalanceSheetDto} />
      ) : (
        <GstView data={result.data as GstDto} />
      )}
    </div>
  );
}

function TrialBalanceView({ data }: { data: TrialBalanceDto | null }) {
  const { t } = useI18n();
  if (!data) return <p className="text-sm text-muted-foreground">{t("accounting.loadFailed")}</p>;

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Scale className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("accounting.reports.trialBalance")}
          <Badge
            variant={data.balanced ? "private" : "destructive"}
            className="rounded-chip"
          >
            {data.balanced ? t("accounting.reports.balanced") : t("accounting.reports.notBalanced")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[30rem]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("accounting.accounts.code")}</TableHead>
                <TableHead>{t("accounting.accounts.name")}</TableHead>
                <TableHead className="text-right">{t("accounting.journal.debit")}</TableHead>
                <TableHead className="text-right">{t("accounting.journal.credit")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.accounts.map((account) => (
                <TableRow key={account.code}>
                  <TableCell className="font-medium tabular-nums">{account.code}</TableCell>
                  <TableCell>{account.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {account.tbDebit > 0 ? fmtInr(account.tbDebit) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {account.tbCredit > 0 ? fmtInr(account.tbCredit) : "—"}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell colSpan={2}>{t("accounting.reports.tbTotal")}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.totalDebit)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.totalCredit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function PnlView({ data }: { data: PnlDto | null }) {
  const { t } = useI18n();
  if (!data) return <p className="text-sm text-muted-foreground">{t("accounting.loadFailed")}</p>;

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="text-base">{t("accounting.reports.pnl")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("accounting.accounts.code")}</TableHead>
              <TableHead>{t("accounting.accounts.name")}</TableHead>
              <TableHead className="text-right">{t("accounting.accounts.balance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.revenue.map((row) => (
              <TableRow key={row.code}>
                <TableCell className="font-medium tabular-nums">{row.code}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-right tabular-nums text-success">
                  {fmtInr(row.amount)}
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold">
              <TableCell colSpan={2}>{t("accounting.reports.totalRevenue")}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtInr(data.totalRevenue)}</TableCell>
            </TableRow>
            {data.expenses.map((row) => (
              <TableRow key={row.code}>
                <TableCell className="font-medium tabular-nums">{row.code}</TableCell>
                <TableCell>{row.name}</TableCell>
                <TableCell className="text-right tabular-nums text-destructive">
                  ({fmtInr(row.amount)})
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold">
              <TableCell colSpan={2}>{t("accounting.reports.totalExpenses")}</TableCell>
              <TableCell className="text-right tabular-nums">({fmtInr(data.totalExpenses)})</TableCell>
            </TableRow>
            <TableRow className="text-base font-bold">
              <TableCell colSpan={2}>{t("accounting.reports.netProfit")}</TableCell>
              <TableCell
                className={`text-right tabular-nums ${data.netProfit >= 0 ? "text-success" : "text-destructive"}`}
              >
                {fmtInr(data.netProfit)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function BalanceSheetView({ data }: { data: BalanceSheetDto | null }) {
  const { t } = useI18n();
  if (!data) return <p className="text-sm text-muted-foreground">{t("accounting.loadFailed")}</p>;

  return (
    <Card className="rounded-card">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("accounting.reports.balanceSheet")}
          <Badge variant={data.balanced ? "private" : "destructive"} className="rounded-chip">
            {data.balanced ? t("accounting.reports.balanced") : t("accounting.reports.notBalanced")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6 p-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold">{t("accounting.reports.assets")}</p>
          <Table>
            <TableBody>
              {data.assets.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="text-muted-foreground">
                    {row.code} · {row.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInr(row.amount)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>{t("accounting.reports.totalAssets")}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.totalAssets)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">{t("accounting.reports.liabilities")}</p>
          <Table>
            <TableBody>
              {data.liabilities.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="text-muted-foreground">
                    {row.code} · {row.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInr(row.amount)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>{t("accounting.reports.totalLiabilities")}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.totalLiabilities)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pt-4 text-sm font-semibold" colSpan={2}>
                  {t("accounting.reports.equity")}
                </TableCell>
              </TableRow>
              {data.equity.map((row) => (
                <TableRow key={row.code}>
                  <TableCell className="text-muted-foreground">
                    {row.code} · {row.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtInr(row.amount)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="text-muted-foreground">
                  {t("accounting.reports.netIncome")}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.netIncomeToDate)}</TableCell>
              </TableRow>
              <TableRow className="font-semibold">
                <TableCell>{t("accounting.reports.totalEquity")}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtInr(data.totalEquity)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function GstView({ data }: { data: GstDto | null }) {
  const { t, locale } = useI18n();
  if (!data) return <p className="text-sm text-muted-foreground">{t("accounting.loadFailed")}</p>;

  const totals = data.totals;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: t("accounting.reports.gstTaxable"), value: fmtInr(totals.taxableInr) },
          { label: "CGST", value: fmtInr(totals.cgst) },
          { label: "SGST", value: fmtInr(totals.sgst) },
          { label: "IGST", value: fmtInr(totals.igst) },
          { label: t("accounting.reports.gstExport"), value: fmtUsd(totals.exportTaxableUsd) },
          { label: t("accounting.reports.gstDomestic"), value: String(totals.domesticInvoices) },
          { label: "B2B", value: String(totals.b2bInvoices) },
          { label: "B2C", value: String(totals.b2cInvoices) },
        ].map((stat) => (
          <Card key={stat.label} className="rounded-card">
            <CardContent className="p-4">
              <p className="truncate text-xs font-medium text-muted-foreground">{stat.label}</p>
              <p className="mt-1 truncate text-lg font-bold tabular-nums">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-card">
        <CardHeader>
          <CardTitle className="text-base">{t("accounting.reports.gstInvoices")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-[24rem]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("accounting.invoices.invoiceNo")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("accounting.invoices.date")}</TableHead>
                  <TableHead>{t("accounting.invoices.customer")}</TableHead>
                  <TableHead className="hidden md:table-cell">GSTIN</TableHead>
                  <TableHead className="text-right">{t("accounting.invoices.taxable")}</TableHead>
                  <TableHead className="text-right">{t("accounting.invoices.tax")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invoices.map((inv) => (
                  <TableRow key={inv.invoiceNo}>
                    <TableCell className="whitespace-nowrap font-medium">{inv.invoiceNo}</TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                      {fmtDate(inv.issuedAt, locale)}
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-[12rem] truncate">{inv.customerEmail}</span>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                      {inv.customerGstin ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {inv.currency === "INR" ? fmtInr(inv.taxableAmount) : fmtUsd(inv.taxableAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {inv.currency === "INR" ? fmtInr(inv.taxAmount) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
