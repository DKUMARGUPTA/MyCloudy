import type { Metadata } from "next";

import { AppShell } from "@/components/doco/app-shell";

/**
 * /accounting — the admin accounting console (R27). Private admin-only
 * surface: never indexed; the client store resolves the session and
 * non-admins get the honest not-authorized panel.
 */
export const metadata: Metadata = {
  title: "Accounting — DocoPDF Admin",
  description:
    "Double-entry books, GST invoicing and financial reports for DocoPDF.",
  robots: { index: false, follow: false },
};

export default function AccountingPageRoute() {
  return <AppShell initialRoute={{ view: "accounting" }} />;
}
