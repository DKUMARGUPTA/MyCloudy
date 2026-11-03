"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/sidocs/modal";
import { BottomSheet } from "@/components/sidocs/bottom-sheet";
import { PasswordInput } from "./password-input";
import { useI18n } from "@/components/providers/locale-provider";
import {
  closeAuthModal,
  login,
  openAuthModal,
  signup,
  useAuth,
  type AuthErrorCode,
} from "@/lib/auth-client";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Store-driven auth modal (#/account, header sign-in, any deep link):
 * useAuth().authModal {open, mode} — so any component can open it without
 * prop drilling. Login <-> signup toggle, inline localized errors, and the
 * brand promise (privacyNote) as the modal's small muted description.
 *
 * Form state lives HERE (the permanently-mounted shell), not inside the
 * dialog body — Radix unmounts closed dialog content, so keeping the values
 * in this component means ESC / backdrop close never loses typed input.
 * Desktop renders the Modal; phones render the BottomSheet (same form).
 */
export function AuthModal() {
  const { t } = useI18n();
  const { authModal } = useAuth();
  const isMobile = useIsMobile();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const isSignup = authModal.mode === "signup";
  const title = isSignup ? t("auth.signupTitle") : t("auth.loginTitle");

  const switchMode = () => {
    setError(null);
    openAuthModal(isSignup ? "login" : "signup");
  };

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      const trimmedEmail = email.trim();
      const trimmedName = name.trim();
      if (!trimmedEmail || !password || (isSignup && !trimmedName)) {
        setError("bad_request");
        return;
      }
      setBusy(true);
      setError(null);
      const res = isSignup
        ? await signup(trimmedName, trimmedEmail, password)
        : await login(trimmedEmail, password);
      setBusy(false);
      if (res.ok) {
        // auth-client closes the modal on success; drop the secret only.
        setPassword("");
        return;
      }
      setError(res.code ?? "server_error");
    },
    [busy, email, name, password, isSignup]
  );

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    closeAuthModal();
    setError(null);
    setBusy(false);
  };

  const form = (
    <form id="auth-form" noValidate onSubmit={submit} className="space-y-4">
      {isSignup ? (
        <div className="space-y-2">
          <Label htmlFor="auth-name">{t("auth.name")}</Label>
          <Input
            id="auth-name"
            value={name}
            autoComplete="name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="auth-email">{t("auth.email")}</Label>
        <Input
          id="auth-email"
          type="email"
          inputMode="email"
          value={email}
          autoComplete="email"
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="auth-password">{t("auth.password")}</Label>
        <PasswordInput
          id="auth-password"
          value={password}
          onChange={setPassword}
          autoComplete={isSignup ? "new-password" : "current-password"}
          ariaInvalid={error ? true : undefined}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {t(`auth.err.${error}`)}
        </p>
      ) : null}

      <Button
        type="submit"
        form="auth-form"
        variant="cta"
        size="touch"
        disabled={busy}
        className="w-full rounded-btn font-semibold"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : null}
        {isSignup ? t("auth.signupCta") : t("auth.loginCta")}
      </Button>

      <button
        type="button"
        onClick={switchMode}
        className="flex min-h-11 w-full items-center justify-center rounded-btn px-3 text-sm font-medium text-primary outline-none transition-colors hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {isSignup ? t("auth.toLogin") : t("auth.toSignup")}
      </button>
    </form>
  );

  if (isMobile) {
    return (
      <BottomSheet
        open={authModal.open}
        onOpenChange={handleOpenChange}
        title={title}
        description={t("auth.privacyNote")}
      >
        {form}
      </BottomSheet>
    );
  }

  return (
    <Modal
      open={authModal.open}
      onOpenChange={handleOpenChange}
      title={title}
      description={t("auth.privacyNote")}
    >
      {form}
    </Modal>
  );
}
