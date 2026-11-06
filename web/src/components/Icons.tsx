type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function ArrowIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 10h11M11 5.5 15.5 10 11 14.5" />
    </svg>
  );
}

export function SparkleIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 3.2 11.6 8.4 16.8 10 11.6 11.6 10 16.8 8.4 11.6 3.2 10 8.4 8.4z" />
    </svg>
  );
}

export function PaletteIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 2.8c-4 0-7.2 3.2-7.2 7.2s3.2 7.2 7.2 7.2c1.3 0 2-.8 2-1.8 0-.8-.6-1.3-.6-2.1 0-1 .9-1.7 2-1.7h1.1c1.6 0 2.5-1 2.5-2.4 0-3.5-3.1-6.4-7-6.4z" />
      <circle cx="6.6" cy="7.2" r=".7" fill="currentColor" stroke="none" />
      <circle cx="10" cy="5.6" r=".7" fill="currentColor" stroke="none" />
      <circle cx="13.3" cy="7.4" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GridIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" />
    </svg>
  );
}

export function PencilIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12.8 3.7 16.3 7.2 7.6 15.9 3.8 16.2 4.1 12.4z" />
      <path d="M11.3 5.2 14.8 8.7" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

export function ChevronIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 8 10 11.5 13.5 8" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 10.5 7.8 14 16 5.5" />
    </svg>
  );
}

export function AlertIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 3.2 17.2 16H2.8z" />
      <path d="M10 8v3.4M10 13.6v.2" />
    </svg>
  );
}

export function RetryIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M16.2 9.2a6.2 6.2 0 1 1-1.9-4.4" />
      <path d="M16.5 3v3.6H12.9" />
    </svg>
  );
}

export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="7" y="7" width="9" height="9" rx="2" />
      <path d="M13 5.5V4.8A1.8 1.8 0 0 0 11.2 3H5.8A1.8 1.8 0 0 0 4 4.8v5.4c0 1 .8 1.8 1.8 1.8h.7" />
    </svg>
  );
}

// Sliders rather than a cog: at 16 px the old spoked gear read as a sun and
// sat right next to the brightness control, which looked like a duplicate.
export function GearIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.6 6.4h5.2M11.6 6.4h5.8M2.6 13.6h3.8M10.2 13.6h7.2" />
      <circle cx="9.7" cy="6.4" r="1.9" />
      <circle cx="8.3" cy="13.6" r="1.9" />
    </svg>
  );
}

export function KeyIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.2" cy="12.8" r="3.4" />
      <path d="m9.8 10.2 6-6M13.4 6.6l1.8 1.8M15.2 4.8l1.8 1.8" />
    </svg>
  );
}

export function SunIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.4v1.6M10 16v1.6M2.4 10h1.6M16 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M15.3 4.7l-1.1 1.1M5.8 14.2l-1.1 1.1" />
    </svg>
  );
}

export function MoonIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15.6 12.4A6.2 6.2 0 0 1 7.6 4.4 6.4 6.4 0 1 0 15.6 12.4z" />
    </svg>
  );
}

export function AutoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="6.6" />
      <path d="M10 3.4v13.2" />
      <path d="M10 3.4a6.6 6.6 0 0 1 0 13.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlayIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4.5 15 10l-8 5.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DownloadIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 3.2v8.4M6.4 8.2 10 11.8l3.6-3.6" />
      <path d="M4 13.6v1.6A1.8 1.8 0 0 0 5.8 17h8.4a1.8 1.8 0 0 0 1.8-1.8v-1.6" />
    </svg>
  );
}

export function BellIcon({ size = 16, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size)} className={className}>
      <path
        d="M10 3.4a4.6 4.6 0 0 0-4.6 4.6c0 4-1.4 5.2-1.4 5.2h12s-1.4-1.2-1.4-5.2A4.6 4.6 0 0 0 10 3.4z"
        fill={filled ? "currentColor" : "none"}
      />
      <path d="M8.4 15.4a1.8 1.8 0 0 0 3.2 0" />
    </svg>
  );
}

export function SignOutIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M11.4 3.6H6a1.8 1.8 0 0 0-1.8 1.8v9.2A1.8 1.8 0 0 0 6 16.4h5.4" />
      <path d="M9.4 10h7.2M14 7.3 16.7 10 14 12.7" />
    </svg>
  );
}

export function UsersIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="7.8" cy="7.2" r="2.7" />
      <path d="M3.2 16.2c0-2.5 2-4.2 4.6-4.2s4.6 1.7 4.6 4.2" />
      <path d="M13.1 5.2a2.4 2.4 0 0 1 0 4.4M14.4 12.4c1.6.5 2.6 1.9 2.6 3.8" opacity="0.7" />
    </svg>
  );
}

export function DiscIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10" cy="10" r="6.8" />
      <circle cx="10" cy="10" r="1.7" />
      <path d="M10 3.4a6.6 6.6 0 0 1 6.2 4.4" opacity="0.55" />
    </svg>
  );
}

// Settings > System: a heartbeat, for diagnostics rather than a cog that would
// repeat the General tab's icon.
export function PulseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.6 10h3.1l2-4.8 3 9.6 2-4.8h4.7" />
    </svg>
  );
}

export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 4v12M4 10h12" />
    </svg>
  );
}
