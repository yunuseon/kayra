import { typed } from "./typed.ts";

export type Theme = "dark" | "light";

export const themeKey = "kayra.theme";

/** The theme this browser chose last, or else its system's. */
export const initialTheme = (stored: string | null, prefersDark: boolean) =>
  stored === "dark" || stored === "light" ? typed<Theme>(stored) : typed<Theme>(prefersDark ? "dark" : "light");
