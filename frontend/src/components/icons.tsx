import type { ReactNode, SVGProps } from "react";

/**
 * 极简线型图标库（Lucide 风格）：24×24 视窗、1.7px 圆头描边、currentColor 着色。
 * 不引入任何运行时依赖，按需 import，tree-shaking 友好。
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconBack = (p: IconProps) => (
  <I {...p}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </I>
);

export const IconSelect = (p: IconProps) => (
  <I {...p}><path d="m4 3 7 18 2-8 8-2Z" /><path d="m13 13 6 6" /></I>
);

export const IconHand = (p: IconProps) => (
  <I {...p}>
    <path d="M8 13V5a2 2 0 0 1 4 0v7M12 7a2 2 0 0 1 4 0v5M16 9a2 2 0 0 1 4 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4 13a2 2 0 0 1 3-2l1 2" />
  </I>
);

export const IconUndo = (p: IconProps) => (
  <I {...p}><path d="M3 10h11a6 6 0 0 1 0 12" /><path d="m7 6-4 4 4 4" /></I>
);

export const IconRedo = (p: IconProps) => (
  <I {...p}><path d="M21 10H10a6 6 0 0 0 0 12" /><path d="m17 6 4 4-4 4" /></I>
);

export const IconHelp = (p: IconProps) => (
  <I {...p}><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01" /></I>
);

export const IconTranslate = (p: IconProps) => (
  <I {...p}>
    <path d="m5 8 6 6" />
    <path d="m4 14 6-6 2-3" />
    <path d="M2 5h12" />
    <path d="M7 2h1" />
    <path d="m22 22-5-10-5 10" />
    <path d="M14 18h6" />
  </I>
);

export const IconLanguages = IconTranslate;

export const IconNote = (p: IconProps) => (
  <I {...p}>
    <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z" />
  </I>
);

export const IconHighlight = (p: IconProps) => (
  <I {...p}>
    <path d="m9 11-6 6v3h9l3-3" />
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z" />
  </I>
);

export const IconComment = (p: IconProps) => (
  <I {...p}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </I>
);

export const IconCopy = (p: IconProps) => (
  <I {...p}>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </I>
);

export const IconRefresh = (p: IconProps) => (
  <I {...p}>
    <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" />
    <path d="M21 3v5h-5" />
  </I>
);

export const IconSearch = (p: IconProps) => (
  <I {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </I>
);

export const IconOutline = (p: IconProps) => (
  <I {...p}>
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </I>
);

export const IconExport = (p: IconProps) => (
  <I {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </I>
);

export const IconSettings = (p: IconProps) => (
  <I {...p}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </I>
);

export const IconUpload = (p: IconProps) => (
  <I {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </I>
);

export const IconDoc = (p: IconProps) => (
  <I {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
    <path d="M10 9H8" />
  </I>
);

export const IconFileText = IconDoc;

export const IconChevronDown = (p: IconProps) => (
  <I {...p}>
    <path d="m6 9 6 6 6-6" />
  </I>
);

export const IconChevronLeft = (p: IconProps) => (
  <I {...p}>
    <path d="m15 18-6-6 6-6" />
  </I>
);

export const IconChevronRight = (p: IconProps) => (
  <I {...p}>
    <path d="m9 18 6-6-6-6" />
  </I>
);

export const IconClose = (p: IconProps) => (
  <I {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </I>
);

export const IconCheck = (p: IconProps) => (
  <I {...p}>
    <path d="M20 6 9 17l-5-5" />
  </I>
);

export const IconWarning = (p: IconProps) => (
  <I {...p}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </I>
);

export const IconEye = (p: IconProps) => (
  <I {...p}>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </I>
);

export const IconEyeOff = (p: IconProps) => (
  <I {...p}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
    <path d="m2 2 20 20" />
  </I>
);

export const IconScan = (p: IconProps) => (
  <I {...p}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8h8" />
    <path d="M7 12h10" />
    <path d="M7 16h6" />
  </I>
);

export const IconZoomIn = (p: IconProps) => (
  <I {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
    <path d="M11 8v6" />
    <path d="M8 11h6" />
  </I>
);

export const IconZoomOut = (p: IconProps) => (
  <I {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
    <path d="M8 11h6" />
  </I>
);

export const IconFit = (p: IconProps) => (
  <I {...p}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </I>
);

export const IconColumns = (p: IconProps) => (
  <I {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M12 3v18" />
  </I>
);

export const IconPlus = (p: IconProps) => (
  <I {...p}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </I>
);

export const IconMinus = (p: IconProps) => (
  <I {...p}>
    <path d="M5 12h14" />
  </I>
);

export const IconBook = (p: IconProps) => (
  <I {...p}>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </I>
);

export const IconTags = (p: IconProps) => (
  <I {...p}>
    <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
    <circle cx="7.5" cy="7.5" r="0.5" fill="currentColor" />
  </I>
);

export const IconCrop = (p: IconProps) => (
  <I {...p}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </I>
);

export const IconInbox = (p: IconProps) => (
  <I {...p}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </I>
);
