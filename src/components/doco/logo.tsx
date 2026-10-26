import { cn } from "@/lib/utils";

/** DocoPDF brand mark — self-hosted inline SVG (no external assets). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7 shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient
          id="docopdf-mark"
          x1="2"
          y1="2"
          x2="30"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0F766E" />
          <stop offset="1" stopColor="#14B8A6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#docopdf-mark)" />
      <path
        d="M11.5 7.5h6.3l4.7 4.7V23a1.8 1.8 0 0 1-1.8 1.8H11.5A1.8 1.8 0 0 1 9.7 23V9.3a1.8 1.8 0 0 1 1.8-1.8Z"
        fill="#FFFFFF"
      />
      <path d="M17.8 7.5l4.7 4.7h-4.7Z" fill="#99F6E4" />
      <text
        x="16.1"
        y="20.6"
        textAnchor="middle"
        fontSize="6.6"
        fontWeight="700"
        fill="#0F766E"
        fontFamily="Inter, system-ui, sans-serif"
      >
        PDF
      </text>
    </svg>
  );
}

/** Full lockup: mark + wordmark. */
export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className="text-lg font-semibold tracking-tight text-foreground">
        DocoPDF
      </span>
    </span>
  );
}
