import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";

/**
 * /admin — the owner's admin dashboard. Private admin-only surface:
 * never indexed; the client store resolves the session and non-admins
 * get the honest not-authorized panel (the APIs re-check the role).
 */
export const metadata: Metadata = {
  title: "Admin Dashboard — DocoPDF Owner",
  description:
    "Owner console for DocoPDF: users, bugs, messages, feedback, audit and site settings.",
  robots: { index: false, follow: false },
};

export default function AdminPageRoute() {
  return <AppShell initialRoute={{ view: "admin" }} />;
}
