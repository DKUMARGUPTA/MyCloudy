"use client";

import { useEffect, useState } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users as UsersIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/doco/empty-state";
import { Modal } from "@/components/doco/modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth-client";
import {
  fetchUsers,
  userAction,
  userDelete,
  type AdminUserDto,
} from "@/lib/admin-client";
import { fmtDate } from "@/components/doco/admin/shared";

const PAGE_SIZE = 10;

/**
 * UsersTab — search + paginated user table with moderation actions
 * (ban/unban, role, soft delete). The owner's own row is protected in
 * the UI (the API guards self role-change/self-delete as well).
 */
export function UsersTab({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { user: me } = useAuth();

  /* Search: qInput is the live textbox value; q is the debounced commit
   * (350ms after the last keystroke). Only q/page changes trigger fetches,
   * so a fast typist fires one request — and the fetched page can never be
   * wiped by a stale timer. */
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<{
    users: AdminUserDto[];
    total: number;
    pages: number;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /* Confirm modal (ban / delete). */
  const [confirm, setConfirm] = useState<{
    kind: "ban" | "delete";
    target: AdminUserDto;
  } | null>(null);

  /* Debounce — commit the query 350ms after the last keystroke. */
  useEffect(() => {
    const id = window.setTimeout(() => {
      setQ(qInput);
      setPage(1);
    }, 350);
    return () => window.clearTimeout(id);
  }, [qInput]);

  /* Data loading — accounting-console pattern: state only updates inside
   * the async .then, never synchronously in the effect body. */
  useEffect(() => {
    let active = true;
    void fetchUsers(q, page, PAGE_SIZE).then((res) => {
      if (!active) return;
      if (res) {
        setData({
          users: res.users,
          total: res.total,
          pages: Math.max(1, Math.ceil(res.total / Math.max(1, res.pageSize))),
        });
      } else {
        setData(null);
        toast({ title: t("admin.toast.failed"), variant: "destructive" });
      }
    });
    return () => {
      active = false;
    };
  }, [q, page, reloadKey, toast, t]);

  const goToPage = (next: number) => {
    const clamped = Math.min(Math.max(1, next), data?.pages ?? 1);
    if (clamped === page) return;
    setData(null);
    setPage(clamped);
  };

  const runAction = async (
    target: AdminUserDto,
    body: { action: "ban" | "unban" | "role"; role?: "user" | "admin" }
  ) => {
    setBusyId(target.id);
    const res = await userAction(target.id, body);
    setBusyId(null);
    if (!res.ok) {
      toast({ title: t("admin.toast.failed"), variant: "destructive" });
      return;
    }
    if (body.action === "ban") toast({ title: t("admin.toast.banned") });
    else if (body.action === "unban") toast({ title: t("admin.toast.unbanned") });
    else toast({ title: t("admin.toast.roleChanged") });
    onChanged();
    setReloadKey((k) => k + 1);
  };

  const runDelete = async (target: AdminUserDto) => {
    setBusyId(target.id);
    const res = await userDelete(target.id);
    setBusyId(null);
    setConfirm(null);
    if (!res.ok) {
      toast({ title: t("admin.toast.failed"), variant: "destructive" });
      return;
    }
    toast({ title: t("admin.toast.deleted") });
    onChanged();
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      {/* Search row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={qInput}
            onChange={(e) => {
              setQInput(e.target.value);
              setData(null);
            }}
            placeholder={t("admin.users.searchPlaceholder")}
            className="h-11 rounded-btn pl-9"
            aria-label={t("admin.users.searchPlaceholder")}
          />
        </div>
        {data ? (
          <p className="text-xs text-muted-foreground">
            {t("admin.users.searchCount", { count: data.users.length, total: data.total })}
          </p>
        ) : null}
      </div>

      {/* Table (desktop) */}
      <div className="hidden overflow-hidden rounded-card border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>{t("admin.users.colName")}</TableHead>
              <TableHead>{t("admin.users.colRole")}</TableHead>
              <TableHead>{t("admin.users.colPlan")}</TableHead>
              <TableHead>{t("admin.users.colJoined")}</TableHead>
              <TableHead>{t("admin.users.colStatus")}</TableHead>
              <TableHead className="w-12 text-right">
                <span className="sr-only">{t("admin.users.colActions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === null ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <div className="h-6 animate-pulse rounded-btn bg-muted" />
                  </TableCell>
                </TableRow>
              ))
            ) : data.users.length > 0 ? (
              data.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden="true">
                        {(u.name?.trim() || u.email || "·")[0]?.toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                          {u.name?.trim() || "—"}
                          {me && u.id === me.id ? (
                            <Badge variant="new" className="rounded-chip px-1.5">
                              {t("admin.users.you")}
                            </Badge>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.role === "admin" ? "default" : "secondary"}
                      className="rounded-chip"
                    >
                      {u.role === "admin"
                        ? t("admin.users.roleAdmin")
                        : t("admin.users.roleUser")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.plan === "pro" ? "pro" : "outline"}
                      className="rounded-chip"
                    >
                      {u.plan === "pro" ? t("admin.users.planPro") : t("admin.users.planFree")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">
                    {fmtDate(u.createdAt, locale)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={u.bannedAt ? "destructive" : "private"}
                      className="rounded-chip"
                    >
                      {u.bannedAt ? t("admin.users.statusBanned") : t("admin.users.statusActive")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <UserActionsCell
                      target={u}
                      isSelf={!!me && u.id === me.id}
                      busy={busyId === u.id}
                      onBan={() => setConfirm({ kind: "ban", target: u })}
                      onDelete={() => setConfirm({ kind: "delete", target: u })}
                      onAction={runAction}
                    />
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="py-10">
                  <EmptyState
                    icon={<UsersIcon />}
                    title={t("admin.users.empty")}
                    className="border-0 bg-transparent p-4"
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Cards (mobile) */}
      <div className="space-y-3 md:hidden">
        {data === null ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-card bg-muted" />
          ))
        ) : data.users.length > 0 ? (
          data.users.map((u) => (
            <div key={u.id} className="rounded-card border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary" aria-hidden="true">
                    {(u.name?.trim() || u.email || "·")[0]?.toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                      {u.name?.trim() || "—"}
                      {me && u.id === me.id ? (
                        <Badge variant="new" className="rounded-chip px-1.5">
                          {t("admin.users.you")}
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                  </div>
                </div>
                <UserActionsCell
                  target={u}
                  isSelf={!!me && u.id === me.id}
                  busy={busyId === u.id}
                  onBan={() => setConfirm({ kind: "ban", target: u })}
                  onDelete={() => setConfirm({ kind: "delete", target: u })}
                  onAction={runAction}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Badge variant={u.role === "admin" ? "default" : "secondary"} className="rounded-chip">
                  {u.role === "admin" ? t("admin.users.roleAdmin") : t("admin.users.roleUser")}
                </Badge>
                <Badge variant={u.plan === "pro" ? "pro" : "outline"} className="rounded-chip">
                  {u.plan === "pro" ? t("admin.users.planPro") : t("admin.users.planFree")}
                </Badge>
                <Badge variant={u.bannedAt ? "destructive" : "private"} className="rounded-chip">
                  {u.bannedAt ? t("admin.users.statusBanned") : t("admin.users.statusActive")}
                </Badge>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {fmtDate(u.createdAt, locale)}
                </span>
              </div>
            </div>
          ))
        ) : (
          <EmptyState icon={<UsersIcon />} title={t("admin.users.empty")} />
        )}
      </div>

      {/* Pagination */}
      {data && data.pages > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t("admin.users.page", { page, pages: data.pages })}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 1 || data === null}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t("admin.users.prev")}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={() => goToPage(page + 1)}
              disabled={page >= data.pages || data === null}
            >
              <span className="hidden sm:inline">{t("admin.users.next")}</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Confirm modal */}
      <Modal
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={
          confirm?.kind === "delete"
            ? t("admin.users.confirmDeleteTitle")
            : t("admin.users.confirmBanTitle")
        }
        description={
          confirm?.kind === "delete"
            ? t("admin.users.confirmDeleteDesc")
            : t("admin.users.confirmBanDesc")
        }
        footer={
          <>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="rounded-btn"
              onClick={() => setConfirm(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="touch"
              className="rounded-btn"
              disabled={busyId === confirm?.target.id}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "delete") void runDelete(confirm.target);
                else void runAction(confirm.target, { action: "ban" }).then(() => setConfirm(null));
              }}
            >
              {busyId === confirm?.target.id ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : confirm?.kind === "delete" ? (
                <Trash2 className="size-4" aria-hidden="true" />
              ) : (
                <Ban className="size-4" aria-hidden="true" />
              )}
              {confirm?.kind === "delete"
                ? t("admin.users.confirmDelete")
                : t("admin.users.confirmBan")}
            </Button>
          </>
        }
      >
        {confirm ? (
          <p className="rounded-btn border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium text-foreground">
              {confirm.target.name?.trim() || confirm.target.email}
            </span>
            {confirm.target.name ? (
              <span className="text-muted-foreground"> · {confirm.target.email}</span>
            ) : null}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}

/* Per-row actions dropdown (shared by table + mobile cards). */
function UserActionsCell({
  target,
  isSelf,
  busy,
  onBan,
  onDelete,
  onAction,
}: {
  target: AdminUserDto;
  isSelf: boolean;
  busy: boolean;
  onBan: () => void;
  onDelete: () => void;
  onAction: (
    target: AdminUserDto,
    body: { action: "ban" | "unban" | "role"; role?: "user" | "admin" }
  ) => Promise<void>;
}) {
  const { t } = useI18n();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 rounded-btn"
          aria-label={t("admin.users.colActions")}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <MoreHorizontal className="size-4" aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 rounded-card">
        <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
          {target.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {target.bannedAt ? (
          <DropdownMenuItem
            onClick={() => void onAction(target, { action: "unban" })}
            className="min-h-11 cursor-pointer rounded-btn"
          >
            <UserRound className="size-4" aria-hidden="true" />
            {t("admin.users.unban")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={onBan}
            className="min-h-11 cursor-pointer rounded-btn text-destructive focus:text-destructive"
            disabled={isSelf}
          >
            <Ban className="size-4" aria-hidden="true" />
            {t("admin.users.ban")}
          </DropdownMenuItem>
        )}
        {target.role === "admin" ? (
          <DropdownMenuItem
            onClick={() => void onAction(target, { action: "role", role: "user" })}
            className="min-h-11 cursor-pointer rounded-btn"
            disabled={isSelf}
          >
            <UserRound className="size-4" aria-hidden="true" />
            {t("admin.users.makeUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={() => void onAction(target, { action: "role", role: "admin" })}
            className="min-h-11 cursor-pointer rounded-btn"
          >
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("admin.users.makeAdmin")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11 cursor-pointer rounded-btn text-destructive focus:text-destructive"
          disabled={isSelf}
          onSelect={() => onDelete()}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {t("admin.users.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
