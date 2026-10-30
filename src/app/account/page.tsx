import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";

/**
 * /account — the account settings view (Phase-10 R26). Private surface:
 * never indexed (no cookies needed to serve the shell — the client store
 * resolves the session and guests get the sign-in prompt).
 */
export const metadata: Metadata = {
  title: "Account settings — DocoPDF",
  description:
    "Manage your DocoPDF account: profile, plan, billing history and security.",
  robots: { index: false, follow: false },
};

export default function AccountPageRoute() {
  return <AppShell initialRoute={{ view: "account" }} />;
}
