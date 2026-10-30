"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Modal } from "@/components/doco/modal";
import { useI18n } from "@/components/providers/locale-provider";
import { useToast } from "@/hooks/use-toast";
import { track } from "@/lib/analytics/ga4";
import {
  closeAuthModal,
  login,
  openAuthModal,
  signup,
  useAuth,
  type AuthErrorCode,
} from "@/lib/auth-client";

/**
 * AuthModal (Phase-10 foundation) — the store-driven login/signup dialog.
 * Any surface can open it via openAuthModal("login" | "signup"); the auth
 * client store owns the open/mode state, so there is no prop drilling.
 *
 * Server error codes map 1:1 to i18n keys (auth.err.<code>) — no raw
 * String(err) ever reaches the user (API contract rule 8). The form lives
 * in a child that mounts fresh on every open, so state resets naturally
 * (no setState-in-effect).
 */
export function AuthModal() {
  const { t } = useI18n();
  const { authModal } = useAuth();
  const mode = authModal.mode;

  return (
    <Modal
      open={authModal.open}
      onOpenChange={(open) => {
        if (open) openAuthModal(mode);
        else closeAuthModal();
      }}
      title={mode === "login" ? t("auth.loginTitle") : t("auth.signupTitle")}
      description={
        mode === "login" ? t("auth.loginDesc") : t("auth.signupDesc")
      }
    >
      {authModal.open ? <AuthForm mode={mode} /> : null}
    </Modal>
  );
}

/** The form body — mounts per open, so every session starts clean. */
function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<AuthErrorCode | null>(null);

  /* Track opens (GA4 no-ops without consent). */
  useEffect(() => {
    track("auth_open", { mode });
  }, [mode]);

  const switchMode = (next: string) => {
    if (busy) return;
    openAuthModal(next === "signup" ? "signup" : "login");
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrorCode(null);

    /* Cheap client-side gates that mirror the zod contracts exactly. */
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || password.length === 0) {
      setErrorCode("bad_request");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setErrorCode("weak_password");
      return;
    }

    setBusy(true);
    const res =
      mode === "login"
        ? await login(trimmedEmail, password)
        : await signup(name.trim(), trimmedEmail, password);
    setBusy(false);

    if (res.ok) {
      track(mode === "login" ? "login_success" : "signup_success");
      toast({
        title: t("auth.welcome", { name: name.trim() || trimmedEmail }),
        description: mode === "login" ? undefined : t("auth.privacyNote"),
      });
      return;
    }
    setErrorCode(res.code ?? "server_error");
  };

  const errorText =
    errorCode !== null ? t(`auth.err.${errorCode}` as never) : null;

  return (
    <>
      <Tabs
        value={mode}
        onValueChange={switchMode}
        className="mt-2"
      >
        <TabsList className="w-full">
          <TabsTrigger value="login" className="rounded-btn">
            {t("auth.tabLogin")}
          </TabsTrigger>
          <TabsTrigger value="signup" className="rounded-btn">
            {t("auth.tabSignup")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
        {mode === "signup" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="auth-name">{t("auth.name")}</Label>
            <Input
              id="auth-name"
              type="text"
              autoComplete="name"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="auth-email">{t("auth.email")}</Label>
          <Input
            id="auth-email"
            type="email"
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="auth-password">{t("auth.password")}</Label>
          <Input
            id="auth-password"
            type="password"
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
          {mode === "signup" ? (
            <p className="text-xs text-muted-foreground">
              {t("auth.passwordHint")}
            </p>
          ) : null}
        </div>

        {errorText !== null ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorText}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="cta"
          size="touch"
          className="w-full rounded-btn"
          disabled={busy}
        >
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("auth.working")}
            </>
          ) : mode === "login" ? (
            t("auth.loginCta")
          ) : (
            t("auth.signupCta")
          )}
        </Button>

        <button
          type="button"
          onClick={() => switchMode(mode === "login" ? "signup" : "login")}
          className="rounded-btn text-center text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {mode === "login" ? t("auth.toSignup") : t("auth.toLogin")}
        </button>
      </form>
    </>
  );
}
