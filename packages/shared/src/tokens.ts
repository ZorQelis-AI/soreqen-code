/**
 * ZorQelis AI / SoreQen design tokens.
 *
 * Mirrors shared/tokens/src/tokens.ts, which is generated from the ZorQelis AI
 * Official Brand Color Palette by scripts/make_brand.py. SoreQen Code is built
 * and published on its own, so it carries a copy — keep the two identical.
 */

export const tokens = {
  brand: {
    void: "#09090B",
    quantumLime: "#D6FF4B",
    abyss: "#050506",
    obsidian: "#111114",
    graphite: "#19191D",
    carbonMist: "#2A2A30",
    signalWhite: "#F5F7F2",
    softSilver: "#A8ADA5",
    ash: "#6F746D",
    quantumDeep: "#8EAD25",
    quantumMist: "#ECFF9A",
  },
  ui: {
    bg: "#09090B",
    bgDeep: "#050506",
    surface: "#111114",
    surface2: "#19191D",
    border: "#2A2A30",
    text: "#F5F7F2",
    muted: "#A8ADA5",
    faint: "#6F746D",
    accent: "#D6FF4B",
    accentHover: "#8EAD25",
    accentGlow: "#ECFF9A",
    onAccent: "#09090B",
    link: "#D6FF4B",
    danger: "#F2786D",
  },
  logo: {
    onDark: { body: "#F5F7F2", accent: "#D6FF4B" },
    onLight: { body: "#09090B", accent: "#8EAD25", ground: "#F5F7F2" },
  },
  gradient: {
    primary: ["#09090B", "#D6FF4B"] as const,
    accent: ["#8EAD25", "#ECFF9A"] as const,
  },
  radius: {
    control: 8,
    card: 12,
    pill: 999,
    appIcon: "22%",
  },
  space: [4, 8, 12, 16, 24, 32, 48, 64, 96] as const,
  motion: {
    ui: 160,
    panel: 240,
    logo: 3200,
    easeIn: "cubic-bezier(.2,.7,.3,1)",
    easePop: "cubic-bezier(.3,1.4,.5,1)",
  },
  type: {
    display: [48, 1.1] as const,
    h1: [34, 1.2] as const,
    h2: [25, 1.3] as const,
    h3: [19, 1.4] as const,
    body: [16, 1.7] as const,
    small: [14, 1.6] as const,
    micro: [12.5, 1.5] as const,
    code: [13.5, 1.6] as const,
    families: {
      ui: "Anek Latin",
      deva: "Anek Devanagari",
      display: "Newsreader",
      mono: "JetBrains Mono",
    },
    weights: [400, 500] as const,
  },
} as const;

export type Tokens = typeof tokens;
export const SOREQEN_TOKENS = tokens;
