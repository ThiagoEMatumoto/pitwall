// Ícones de traço no dialeto do app (lucide: viewBox 24, stroke 2, cap/join
// redondos). Redesenhados aqui porque o bundle do vídeo não carrega lucide —
// são poucas formas e todas aparecem em tela por 2 segundos.

import { C } from "./tokens";

interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const base = (size: number, color: string, strokeWidth: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: color,
  strokeWidth,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconFolderTree: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <path d="M3 4h5l1.5 2H14v5H3z" />
    <path d="M3 13v6h6" />
    <path d="M13 19h8" />
    <path d="M13 14h8" />
  </svg>
);

export const IconTerminal: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <path d="M4 17l6-5-6-5" />
    <path d="M12 19h8" />
  </svg>
);

export const IconDiagram: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <rect x="3" y="3" width="7" height="6" rx="1.5" />
    <rect x="14" y="15" width="7" height="6" rx="1.5" />
    <path d="M6.5 9v5a2 2 0 0 0 2 2H14" />
  </svg>
);

export const IconUsers: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <path d="M15 20v-1.5A3.5 3.5 0 0 0 11.5 15h-5A3.5 3.5 0 0 0 3 18.5V20" />
    <circle cx="9" cy="8" r="3.2" />
    <path d="M21 20v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
    <path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
  </svg>
);

export const IconTarget: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
  </svg>
);

export const IconSettings: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" />
  </svg>
);

export const IconMic: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </svg>
);

export const IconSend: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </svg>
);

export const IconSparkle: React.FC<IconProps> = ({
  size = 24,
  color = "currentColor",
  strokeWidth = 2,
}) => (
  <svg {...base(size, color, strokeWidth)}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
  </svg>
);

/** A marca: duas barras + "O Ápice" no centro. Fiel ao pitwall-logo.svg. */
export const PitwallMark: React.FC<{ size?: number; gradientId?: string }> = ({
  size = 28,
  gradientId = "pw-apex",
}) => (
  <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
    <defs>
      <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={C.accent2} />
        <stop offset="1" stopColor={C.accent} />
      </linearGradient>
    </defs>
    <rect x="4" y="19.5" width="11.5" height="5" rx="2.5" fill={C.brandBar} />
    <rect x="28.5" y="19.5" width="11.5" height="5" rx="2.5" fill={C.brandBar} />
    <circle cx="22" cy="22" r="3.4" fill={`url(#${gradientId})`} />
  </svg>
);
