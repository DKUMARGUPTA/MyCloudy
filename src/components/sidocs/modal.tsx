"use client";

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Optional extra classes for the content panel (e.g. width). */
  contentClassName?: string;
}

/**
 * Sidocs Modal — accessible dialog wrapper (PRD §3.3: focus trap, ESC close).
 * On mobile it renders as a centered dialog; use BottomSheet for the
 * mobile-first bottom-sheet pattern instead.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
}: ModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={contentClassName ?? "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
