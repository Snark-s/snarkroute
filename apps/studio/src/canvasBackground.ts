export type CanvasBackgroundTheme = "gear-dark" | "plain-dark" | "grid" | "dots" | "hex" | "honeycomb";

export type CanvasThemeConfig = {
  id: CanvasBackgroundTheme;
  label: string;
  description: string;
  reactFlowBackground: "lines" | "dots" | null;
};

export const CANVAS_BACKGROUND_STORAGE_KEY = "snarkroute-studio:canvas-background-theme";
export const DEFAULT_CANVAS_BACKGROUND_THEME: CanvasBackgroundTheme = "gear-dark";

export const availableCanvasThemes: CanvasThemeConfig[] = [
  {
    id: "gear-dark",
    label: "Gear Dark",
    description: "Subtle repeating gear pattern",
    reactFlowBackground: null
  },
  {
    id: "plain-dark",
    label: "Plain Dark",
    description: "Clean dark canvas without a pattern",
    reactFlowBackground: null
  },
  {
    id: "grid",
    label: "Grid",
    description: "React Flow line grid",
    reactFlowBackground: "lines"
  },
  {
    id: "dots",
    label: "Dots",
    description: "React Flow dotted guide",
    reactFlowBackground: "dots"
  },
  {
    id: "hex",
    label: "Hex",
    description: "Subtle hexagon tiling",
    reactFlowBackground: null
  },
  {
    id: "honeycomb",
    label: "Honeycomb",
    description: "Dense honeycomb cell pattern",
    reactFlowBackground: null
  }
];

export function isCanvasBackgroundTheme(value: string): value is CanvasBackgroundTheme {
  return availableCanvasThemes.some((theme) => theme.id === value);
}

export function loadCanvasBackgroundTheme(): CanvasBackgroundTheme {
  const saved = localStorage.getItem(CANVAS_BACKGROUND_STORAGE_KEY);
  return saved && isCanvasBackgroundTheme(saved) ? saved : DEFAULT_CANVAS_BACKGROUND_THEME;
}

export function saveCanvasBackgroundTheme(theme: CanvasBackgroundTheme) {
  localStorage.setItem(CANVAS_BACKGROUND_STORAGE_KEY, theme);
}
