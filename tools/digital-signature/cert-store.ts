/**
 * Digital signature — certificate session store.
 *
 * The .pfx/.p12 the user picks lives in this tab's MEMORY only: never
 * localStorage, never IndexedDB, never any persistence — a certificate
 * file must not survive a refresh (unlike sign-pdf's drawn signature
 * library, this is a credential). The password never touches this
 * store at all; it rides the option values (also in-memory).
 *
 * config.collectAssets ships the file to the worker under the fixed
 * name "dsig-cert.p12" (the worker's CERT_ASSET_NAME) — the same
 * in-memory structured-clone channel sign-pdf uses for its PNGs.
 */

let current: File | null = null;

/** Sets (or clears with null) the certificate for this tab session. */
export function setCertFile(file: File | null): void {
  current = file;
}

/** The certificate held for this tab session (null when none). */
export function getCertFile(): File | null {
  return current;
}

/** The certificate as the worker run asset (fixed name, in-memory). */
export function certAssetFiles(): File[] {
  if (!current) return [];
  try {
    return [
      new File([current], "dsig-cert.p12", {
        type: "application/x-pkcs12",
      }),
    ];
  } catch {
    return [];
  }
}
