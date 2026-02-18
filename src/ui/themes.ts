import type { ITheme } from "@xterm/xterm";

export interface Theme {
  name: string;

  // UI CSS custom properties
  bg: string;
  panel: string;
  panel2: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  line: string;
  gradientA: string;
  gradientB: string;
  ready: string;
  readyGlow: string;
  busy: string;
  busyTrack: string;
  inputText: string;
  surface: string;
  surfaceHover: string;
  surfaceBorder: string;
  buttonHover: string;
  backdrop: string;
  overlay: string;

  // PTY hash-color tuning
  hashSaturation: number;
  hashLightness: number;

  // Full xterm.js theme
  terminal: ITheme;
}

// ---------------------------------------------------------------------------
// Built-in themes
// ---------------------------------------------------------------------------

const neutral: Theme = {
  name: "Neutral",
  bg: "#0a0a0a",
  panel: "#111111",
  panel2: "#0e0e0e",
  text: "#e5e5e5",
  muted: "#737373",
  accent: "#3b82f6",
  danger: "#ef4444",
  line: "rgba(255, 255, 255, 0.08)",
  gradientA: "#141414",
  gradientB: "#161416",
  ready: "#22c55e",
  readyGlow: "rgba(34, 197, 94, 0.18)",
  busy: "#f59e0b",
  busyTrack: "rgba(245, 158, 11, 0.3)",
  inputText: "#e5e5e5",
  surface: "rgba(255, 255, 255, 0.03)",
  surfaceHover: "rgba(255, 255, 255, 0.06)",
  surfaceBorder: "rgba(255, 255, 255, 0.08)",
  buttonHover: "rgba(255, 255, 255, 0.15)",
  backdrop: "rgba(0, 0, 0, 0.4)",
  overlay: "rgba(0, 0, 0, 0.25)",
  hashSaturation: 70,
  hashLightness: 68,
  terminal: {
    background: "#2d2d2d",
    foreground: "#d4d4d4",
    cursor: "#3b82f6",
    selectionBackground: "rgba(59, 130, 246, 0.35)",
    black: "#808080",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#d4d4d4",
    brightBlack: "#a0a0a0",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde047",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  },
};

const dracula: Theme = {
  name: "Dracula",
  bg: "#0b0e14",
  panel: "#101626",
  panel2: "#0f1320",
  text: "#e7ecff",
  muted: "#99a2c2",
  accent: "#ffcc66",
  danger: "#ff5f87",
  line: "rgba(255, 255, 255, 0.08)",
  gradientA: "#1a2440",
  gradientB: "#2a1d33",
  ready: "#5fd18c",
  readyGlow: "rgba(95, 209, 140, 0.18)",
  busy: "#ffb870",
  busyTrack: "rgba(255, 184, 112, 0.3)",
  inputText: "#d9f0ff",
  surface: "rgba(255, 255, 255, 0.03)",
  surfaceHover: "rgba(255, 255, 255, 0.06)",
  surfaceBorder: "rgba(255, 255, 255, 0.08)",
  buttonHover: "rgba(255, 255, 255, 0.18)",
  backdrop: "rgba(0, 0, 0, 0.4)",
  overlay: "rgba(0, 0, 0, 0.25)",
  hashSaturation: 85,
  hashLightness: 72,
  terminal: {
    background: "#0b0e14",
    foreground: "#e7ecff",
    cursor: "#ffcc66",
    selectionBackground: "rgba(255, 204, 102, 0.25)",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};

const tokyoNight: Theme = {
  name: "Tokyo Night",
  bg: "#1a1b26",
  panel: "#16161e",
  panel2: "#13131a",
  text: "#c0caf5",
  muted: "#565f89",
  accent: "#7aa2f7",
  danger: "#f7768e",
  line: "rgba(255, 255, 255, 0.07)",
  gradientA: "#1a1b36",
  gradientB: "#24183a",
  ready: "#9ece6a",
  readyGlow: "rgba(158, 206, 106, 0.18)",
  busy: "#e0af68",
  busyTrack: "rgba(224, 175, 104, 0.3)",
  inputText: "#c0caf5",
  surface: "rgba(255, 255, 255, 0.03)",
  surfaceHover: "rgba(255, 255, 255, 0.06)",
  surfaceBorder: "rgba(255, 255, 255, 0.08)",
  buttonHover: "rgba(255, 255, 255, 0.18)",
  backdrop: "rgba(0, 0, 0, 0.45)",
  overlay: "rgba(0, 0, 0, 0.28)",
  hashSaturation: 75,
  hashLightness: 70,
  terminal: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
    selectionBackground: "rgba(122, 162, 247, 0.25)",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
};

const solarizedDark: Theme = {
  name: "Solarized Dark",
  bg: "#002b36",
  panel: "#073642",
  panel2: "#003845",
  text: "#839496",
  muted: "#586e75",
  accent: "#b58900",
  danger: "#dc322f",
  line: "rgba(255, 255, 255, 0.07)",
  gradientA: "#073642",
  gradientB: "#0a3540",
  ready: "#859900",
  readyGlow: "rgba(133, 153, 0, 0.2)",
  busy: "#cb4b16",
  busyTrack: "rgba(203, 75, 22, 0.3)",
  inputText: "#93a1a1",
  surface: "rgba(255, 255, 255, 0.03)",
  surfaceHover: "rgba(255, 255, 255, 0.06)",
  surfaceBorder: "rgba(255, 255, 255, 0.08)",
  buttonHover: "rgba(255, 255, 255, 0.15)",
  backdrop: "rgba(0, 0, 0, 0.45)",
  overlay: "rgba(0, 0, 0, 0.28)",
  hashSaturation: 60,
  hashLightness: 65,
  terminal: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#b58900",
    selectionBackground: "rgba(181, 137, 0, 0.25)",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
};

const solarizedLight: Theme = {
  name: "Solarized Light",
  bg: "#fdf6e3",
  panel: "#eee8d5",
  panel2: "#e8e1cc",
  text: "#657b83",
  muted: "#93a1a1",
  accent: "#b58900",
  danger: "#dc322f",
  line: "rgba(0, 0, 0, 0.1)",
  gradientA: "#eee8d5",
  gradientB: "#f0e8d0",
  ready: "#859900",
  readyGlow: "rgba(133, 153, 0, 0.18)",
  busy: "#cb4b16",
  busyTrack: "rgba(203, 75, 22, 0.25)",
  inputText: "#586e75",
  surface: "rgba(0, 0, 0, 0.04)",
  surfaceHover: "rgba(0, 0, 0, 0.07)",
  surfaceBorder: "rgba(0, 0, 0, 0.1)",
  buttonHover: "rgba(0, 0, 0, 0.12)",
  backdrop: "rgba(0, 0, 0, 0.25)",
  overlay: "rgba(0, 0, 0, 0.12)",
  hashSaturation: 65,
  hashLightness: 42,
  terminal: {
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#b58900",
    selectionBackground: "rgba(181, 137, 0, 0.2)",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
};

const neutralLight: Theme = {
  name: "Neutral Light",
  bg: "#fafafa",
  panel: "#ffffff",
  panel2: "#f5f5f5",
  text: "#171717",
  muted: "#737373",
  accent: "#2563eb",
  danger: "#dc2626",
  line: "rgba(0, 0, 0, 0.1)",
  gradientA: "#f5f5f5",
  gradientB: "#f5f3f7",
  ready: "#16a34a",
  readyGlow: "rgba(22, 163, 74, 0.18)",
  busy: "#d97706",
  busyTrack: "rgba(217, 119, 6, 0.25)",
  inputText: "#171717",
  surface: "rgba(0, 0, 0, 0.03)",
  surfaceHover: "rgba(0, 0, 0, 0.06)",
  surfaceBorder: "rgba(0, 0, 0, 0.1)",
  buttonHover: "rgba(0, 0, 0, 0.1)",
  backdrop: "rgba(0, 0, 0, 0.25)",
  overlay: "rgba(0, 0, 0, 0.12)",
  hashSaturation: 60,
  hashLightness: 40,
  terminal: {
    background: "#fafafa",
    foreground: "#171717",
    cursor: "#2563eb",
    selectionBackground: "rgba(37, 99, 235, 0.2)",
    black: "#171717",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#f5f5f5",
    brightBlack: "#737373",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#ffffff",
  },
};

const light: Theme = {
  name: "Light",
  bg: "#ffffff",
  panel: "#f5f5f5",
  panel2: "#eeeeee",
  text: "#24292e",
  muted: "#6a737d",
  accent: "#0366d6",
  danger: "#d73a49",
  line: "rgba(0, 0, 0, 0.1)",
  gradientA: "#f0f4f8",
  gradientB: "#f5f0fa",
  ready: "#28a745",
  readyGlow: "rgba(40, 167, 69, 0.18)",
  busy: "#e36209",
  busyTrack: "rgba(227, 98, 9, 0.25)",
  inputText: "#24292e",
  surface: "rgba(0, 0, 0, 0.03)",
  surfaceHover: "rgba(0, 0, 0, 0.06)",
  surfaceBorder: "rgba(0, 0, 0, 0.1)",
  buttonHover: "rgba(0, 0, 0, 0.1)",
  backdrop: "rgba(0, 0, 0, 0.25)",
  overlay: "rgba(0, 0, 0, 0.1)",
  hashSaturation: 60,
  hashLightness: 40,
  terminal: {
    background: "#ffffff",
    foreground: "#24292e",
    cursor: "#0366d6",
    selectionBackground: "rgba(3, 102, 214, 0.2)",
    black: "#24292e",
    red: "#d73a49",
    green: "#28a745",
    yellow: "#dbab09",
    blue: "#0366d6",
    magenta: "#5a32a3",
    cyan: "#0598bc",
    white: "#e1e4e8",
    brightBlack: "#6a737d",
    brightRed: "#cb2431",
    brightGreen: "#22863a",
    brightYellow: "#b08800",
    brightBlue: "#005cc5",
    brightMagenta: "#5a32a3",
    brightCyan: "#3192aa",
    brightWhite: "#fafbfc",
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const THEMES: ReadonlyMap<string, Theme> = new Map<string, Theme>([
  ["neutral", neutral],
  ["neutral-light", neutralLight],
  ["dracula", dracula],
  ["tokyo-night", tokyoNight],
  ["solarized-dark", solarizedDark],
  ["solarized-light", solarizedLight],
  ["light", light],
]);

export const DEFAULT_THEME_KEY = "neutral";

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const CSS_VAR_MAP: [keyof Theme, string][] = [
  ["bg", "--bg"],
  ["panel", "--panel"],
  ["panel2", "--panel2"],
  ["text", "--text"],
  ["muted", "--muted"],
  ["accent", "--accent"],
  ["danger", "--danger"],
  ["line", "--line"],
  ["gradientA", "--gradient-a"],
  ["gradientB", "--gradient-b"],
  ["ready", "--ready"],
  ["readyGlow", "--ready-glow"],
  ["busy", "--busy"],
  ["busyTrack", "--busy-track"],
  ["inputText", "--input-text"],
  ["surface", "--surface"],
  ["surfaceHover", "--surface-hover"],
  ["surfaceBorder", "--surface-border"],
  ["buttonHover", "--button-hover"],
  ["backdrop", "--backdrop"],
  ["overlay", "--overlay"],
];

export function applyTheme(
  theme: Theme,
  terminals: Iterable<{ term: { options: { theme?: ITheme } } }>,
): void {
  const style = document.documentElement.style;
  for (const [key, varName] of CSS_VAR_MAP) {
    style.setProperty(varName, theme[key] as string);
  }

  for (const st of terminals) {
    st.term.options.theme = theme.terminal;
  }
}
