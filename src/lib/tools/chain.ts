/**
 * Chain mode (PRD §6.4): a finished result is passed to the next tool
 * without re-selecting the file. The handoff lives in memory only — the
 * files themselves are working copies under the OPFS working dir (see
 * lib/storage/opfs.ts) which are cleared when the chain ends.
 */

export interface ChainHandoff {
  /** Tool that produced the files (for the "A > B" breadcrumb). */
  fromToolId: string;
  /** Working-copy ids + File objects handed to the next tool. */
  items: { id: string; file: File }[];
}

let handoff: ChainHandoff | null = null;

/** Sets the pending handoff (called by the result view's "What next?"). */
export function setChainHandoff(next: ChainHandoff): void {
  handoff = next;
}

/** Consumes the pending handoff, if the next tool matches. */
export function takeChainHandoff(): ChainHandoff | null {
  const current = handoff;
  handoff = null;
  return current;
}

/** Peeks without consuming (breadcrumb rendering on re-renders). */
export function peekChainHandoff(): ChainHandoff | null {
  return handoff;
}

/** Drops any pending handoff (leaving to a non-tool view cancels the chain). */
export function clearChainHandoff(): void {
  handoff = null;
}
