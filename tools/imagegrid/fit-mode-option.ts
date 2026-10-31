import type { OptionField } from "@/lib/tools/config-types";

/**
 * R44 — the "Image fit" (contain vs fill/cover) option block, shared by
 * images-to-pdf and every imagegrid preset config. Insert right after the
 * `margin` select. "fill" pairs with the worker's clip-based coverInto so
 * the ORIGINAL image bytes still embed untouched (crop = clip, not
 * re-encode) — fixed-size pages lose their blank side bands.
 */
export const FIT_MODE_OPTION: OptionField = {
  kind: "select",
  id: "fitMode",
  label: { en: "Image fit", hi: "तस्वीर फ़िट" },
  hint: {
    en: "Fit keeps the whole photo (blank borders possible); Fill covers the page and crops edges",
    hi: "फ़िट पूरी तस्वीर रखता है (खाली किनारे आ सकते हैं); फ़िल पेज ढकता है और किनारे काटता है",
  },
  choices: [
    {
      value: "contain",
      label: { en: "Fit whole image", hi: "पूरी तस्वीर रखें" },
    },
    {
      value: "fill",
      label: { en: "Fill page (crop edges)", hi: "पेज भरें (किनारे कटें)" },
    },
  ],
  default: "contain",
};
