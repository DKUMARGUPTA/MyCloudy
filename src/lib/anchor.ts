/**
 * In-app plain-anchor navigation (P7-SEO fix) — scrolls to an element
 * WITHOUT touching location.hash, so the hash router never mistakes
 * "#section" links for route changes (previously a plain anchor jumped
 * the app back to the home view when pressed inside /tool/<id> pages).
 *
 * `focusTarget` (skip-to-content link) also moves keyboard focus, which
 * the browser's default anchor behaviour would have done for free.
 */

export function scrollToAnchor(
  id: string,
  options?: { focusTarget?: boolean; smooth?: boolean }
): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (options?.focusTarget) {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }
  el.scrollIntoView({
    behavior: options?.smooth === false ? "auto" : "smooth",
    block: "start",
  });
}

/** Click handler for <a href="#id"> links that must not touch the hash. */
export function anchorClickHandler(
  id: string,
  options?: { focusTarget?: boolean }
): (event: React.MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    event.preventDefault();
    scrollToAnchor(id, options);
  };
}
