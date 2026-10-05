import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** Icon node rendered inside a tinted circle (24px grid recommended). */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional action, e.g. a Button (PRD §3.3: illustration + 1 line + action). */
  action?: ReactNode;
  className?: string;
}

/**
 * DocoPDF EmptyState — friendly empty/zero state with icon, message and action.
 * Used for empty lists, "no files yet", "no search results", etc.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border bg-background p-8 text-center",
        className
      )}
    >
      {icon ? (
        <div
          className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground [&>svg]:size-6"
          aria-hidden="true"
        >
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
