"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * App-level React error boundary (iOS hardening).
 *
 * Catches render/hydration crashes that the inline boot watchdog can't
 * (anything after mount) and shows a bilingual, self-contained fallback —
 * no Tailwind/i18n dependencies, because either may be part of the failure.
 * The captured error is also pushed onto window.__DP_ERRORS__ so the
 * diagnostic report (window.__DP_REPORT__ / Copy report button) includes
 * it for support.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      const w = window as unknown as { __DP_ERRORS__?: string[] };
      if (Array.isArray(w.__DP_ERRORS__)) {
        w.__DP_ERRORS__.push(
          `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` +
            (info?.componentStack ? ` | ${String(info.componentStack).slice(0, 240)}` : "")
        );
      }
      // Surface it for the browser console too (error boundaries swallow).
      console.error("[DocoPDF] render error caught:", error, info?.componentStack);
    } catch {
      /* nothing more we can do */
    }
  }

  private copyReport = () => {
    const w = window as unknown as {
      __DP_REPORT__?: () => string;
      navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } };
    };
    const text =
      typeof w.__DP_REPORT__ === "function"
        ? w.__DP_REPORT__()
        : `DocoPDF error: ${this.state.error?.message ?? "unknown"}`;
    try {
      if (w.navigator?.clipboard?.writeText) {
        void w.navigator.clipboard.writeText(text).then(
          () => undefined,
          () => undefined
        );
        return;
      }
      const box = document.createElement("textarea");
      box.value = text;
      box.style.position = "fixed";
      box.style.left = "-9999px";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      box.remove();
    } catch {
      /* clipboard is best-effort */
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        dir="ltr"
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px",
          background: "var(--background, #ffffff)",
          color: "var(--foreground, #0f172a)",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
        }}
      >
        <div style={{ maxWidth: 440, width: "100%" }}>
          <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 6px" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 14, color: "#475569", margin: "0 0 6px" }}>
            कुछ गड़बड़ हो गई। कृपया पेज फिर से लोड करें।
          </p>
          <p
            style={{
              fontSize: 12,
              color: "#b91c1c",
              fontFamily: "ui-monospace, Menlo, Consolas, monospace",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 10,
              padding: 10,
              marginTop: 12,
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {String(error.name)}: {String(error.message)}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                flex: 1,
                minHeight: 44,
                minWidth: 140,
                border: 0,
                borderRadius: 10,
                background: "#0f766e",
                color: "#ffffff",
                fontSize: 15,
                fontWeight: 600,
                padding: "10px 18px",
                cursor: "pointer",
              }}
            >
              Reload / फिर से लोड
            </button>
            <button
              type="button"
              onClick={this.copyReport}
              style={{
                flex: 1,
                minHeight: 44,
                minWidth: 140,
                border: "1px solid #cbd5e1",
                borderRadius: 10,
                background: "transparent",
                fontSize: 15,
                fontWeight: 600,
                padding: "10px 18px",
                cursor: "pointer",
              }}
            >
              Copy report
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#94a3b8", margin: "14px 0 0" }}>
            DocoPDF — free PDF tools. Files stay on your device.
          </p>
        </div>
      </div>
    );
  }
}
