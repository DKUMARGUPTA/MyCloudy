/**
 * Accounting module (R27) — public surface. See docs/rules/17-ACCOUNTING.md
 * for the design brief: double-entry books for the DocoPDF business,
 * GST-compliant invoicing, accrual revenue recognition, and the standard
 * report set (trial balance / P&L / balance sheet / GST summary).
 */
export * from "./chart";
export * from "./post";
export * from "./invoice";
export * from "./sync";
export * from "./reports";
