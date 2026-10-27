"use client";

import { useEffect, useState } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users as UsersIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/components/providers/locale-provider";
import { useAuth } from "@/lib/auth-client";
import { Modal } from "@/components/sidocs/modal";
import {
  adminErrorCode,
  deleteAdminUser,
  fetchAdminUsers,
  patchAdminUser,
  type AdminUser,
  type AdminUserRole,
  type AdminUsersPage,
} from "./admin-api";
import {
  adminErrorText,
  AdminEmpty,
  AdminErrorCard,
  AdminModuleProps,
  AdminRowsSkeleton,
  formatAdminDate,
  isAdminLoading,
  useDebouncedValue,
  type AdminLoad,
} from "./admin-shared";

/**
 * Users manager (#/admin/users): debounced search, paginated table
 * (cards on mobile) with ban/restore, role and delete actions. Destructive
 * delete goes through a confirm dialog; every action toasts + refetches.
 */

const PAGE_SIZE = 10;

export function UsersPanel({ refreshToken, onForbidden }: AdminModuleProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { user: me } = useAuth();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [page, setPage] = useState(1);
  const [load, setLoad] = useState<AdminLoad<AdminUsersPage>>({
    data: null,
    error: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    fetchAdminUsers(
      { q: debouncedQuery, page, pageSize: PAGE_SIZE },
      controller.signal
    )
      .then((data) => {
        if (!active) return;
        setLoad({ data, error: null });
        // Deleting the last row of the last page would leave a blank
        // page — step back to the new last page.
        const lastPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
        if (data.users.length === 0 && data.total > 0 && page > lastPage) {
          setPage(lastPage);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const code = adminErrorCode(error);
        if (code === "forbidden") onForbidden();
        else setLoad({ data: null, error: code });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [debouncedQuery, page, refreshToken, reloadKey, onForbidden]);

  function onSearchChange(value: string): void {
    setQuery(value);
    setPage(1);
  }

  async function runAction(
    user: AdminUser,
    action: () => Promise<unknown>,
    successTitle: string
  ): Promise<void> {
    setBusyId(user.id);
    try {
      await action();
      toast({ title: successTitle });
      setReloadKey((key) => key + 1);
    } catch (error: unknown) {
      const code = adminErrorCode(error);
      if (code === "forbidden") onForbidden();
      else toast({ title: adminErrorText(t, code), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  function toggleBan(user: AdminUser): void {
    const banned = user.bannedAt !== null;
    void runAction(
      user,
      () =>
        patchAdminUser(user.id, banned ? { action: "unban" } : { action: "ban" }),
      banned ? t("admin.users.active") : t("admin.users.banned")
    );
  }

  function changeRole(user: AdminUser): void {
    const makeAdmin = user.role !== "admin";
    void runAction(
      user,
      () =>
        patchAdminUser(user.id, {
          action: "role",
          role: makeAdmin ? "admin" : "user",
        }),
      t("account.saved")
    );
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) return;
    const target = deleteTarget;
    await runAction(
      target,
      () => deleteAdminUser(target.id),
      t("account.saved")
    );
    setDeleteTarget(null);
  }

  if (load.error !== null) {
    return (
      <AdminErrorCard
        code={load.error}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const users = load.data?.users ?? [];
  const total = load.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">
        {t("admin.nav.users")}
      </h2>

      <div className="relative mt-4">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("admin.users.search")}
          aria-label={t("common.search")}
          className="h-10 pl-9"
        />
      </div>

      <div className="mt-4">
        {isAdminLoading(load) ? (
          <AdminRowsSkeleton rows={5} />
        ) : users.length === 0 ? (
          <AdminEmpty />
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("auth.email")}</TableHead>
                    <TableHead>{t("admin.users.role")}</TableHead>
                    <TableHead>{t("admin.users.plan")}</TableHead>
                    <TableHead>{t("admin.users.joined")}</TableHead>
                    <TableHead>{t("admin.users.status")}</TableHead>
                    <TableHead className="w-12" aria-hidden="true" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{user.email}</span>
                          {user.name ? (
                            <span className="text-xs text-muted-foreground">
                              {user.name}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={user.role} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {user.plan === "free"
                          ? t("account.planFree")
                          : user.plan}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatAdminDate(user.createdAt, locale)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge banned={user.bannedAt !== null} />
                      </TableCell>
                      <TableCell>
                        <RowActions
                          user={user}
                          busy={busyId === user.id}
                          self={me?.id === user.id}
                          onBan={() => toggleBan(user)}
                          onRole={() => changeRole(user)}
                          onDelete={() => setDeleteTarget(user)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: card list */}
            <ul className="space-y-3 md:hidden">
              {users.map((user) => (
                <li
                  key={user.id}
                  className="rounded-xl border bg-card p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {user.email}
                      </p>
                      {user.name ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {user.name}
                        </p>
                      ) : null}
                    </div>
                    <RowActions
                      user={user}
                      busy={busyId === user.id}
                      self={me?.id === user.id}
                      onBan={() => toggleBan(user)}
                      onRole={() => changeRole(user)}
                      onDelete={() => setDeleteTarget(user)}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <RoleBadge role={user.role} />
                    <Badge variant="secondary">
                      {user.plan === "free" ? t("account.planFree") : user.plan}
                    </Badge>
                    <StatusBadge banned={user.bannedAt !== null} />
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t("admin.users.joined")}:{" "}
                      {formatAdminDate(user.createdAt, locale)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <UsersIcon className="size-4" aria-hidden="true" />
                <span className="tabular-nums">{total}</span>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10"
                  aria-label={t("common.back")}
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {page} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-10"
                  aria-label={t("resume.next")}
                  disabled={page >= pageCount}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      <Modal
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("admin.users.delete")}
        description={t("admin.users.deleteConfirm")}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busyId !== null}
              onClick={() => void confirmDelete()}
            >
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <p className="break-all text-sm text-muted-foreground">
          {deleteTarget ? deleteTarget.email : ""}
        </p>
      </Modal>
    </section>
  );
}

function RoleBadge({ role }: { role: AdminUserRole }) {
  if (role === "admin") {
    return (
      <Badge className="gap-1 border-transparent bg-primary/10 font-normal text-primary">
        <ShieldCheck className="size-3" aria-hidden="true" />
        <span className="capitalize">{role}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      <span className="capitalize">{role}</span>
    </Badge>
  );
}

function StatusBadge({ banned }: { banned: boolean }) {
  const { t } = useI18n();
  if (banned) {
    return (
      <Badge className="gap-1 border-transparent bg-destructive/10 font-normal text-destructive">
        <Ban className="size-3" aria-hidden="true" />
        {t("admin.users.banned")}
      </Badge>
    );
  }
  return (
    <Badge variant="new" className="font-normal">
      {t("admin.users.active")}
    </Badge>
  );
}

function RowActions({
  user,
  busy,
  self,
  onBan,
  onRole,
  onDelete,
}: {
  user: AdminUser;
  busy: boolean;
  self: boolean;
  onBan: () => void;
  onRole: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const banned = user.bannedAt !== null;
  const isAdmin = user.role === "admin";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          aria-label={user.email}
          disabled={busy}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={busy || self} onClick={onBan}>
          {banned ? (
            <ShieldCheck className="size-4" aria-hidden="true" />
          ) : (
            <Ban className="size-4" aria-hidden="true" />
          )}
          {banned ? t("admin.users.unban") : t("admin.users.ban")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy || self} onClick={onRole}>
          {isAdmin ? (
            <UserCheck className="size-4" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-4" aria-hidden="true" />
          )}
          {isAdmin ? t("admin.users.removeAdmin") : t("admin.users.makeAdmin")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy || self}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {t("admin.users.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
