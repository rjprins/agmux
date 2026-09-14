const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Wrap text so a TUI reads it as one paste instead of typed keys. */
export function bracketedPaste(text: string): string {
  // An embedded end marker would close the paste early and send the rest as keystrokes.
  return `${PASTE_START}${text.replace(/\x1b/g, "")}${PASTE_END}`;
}
