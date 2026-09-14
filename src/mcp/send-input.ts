export type SendInputMessage =
  | { type: "mobile_submit"; ptyId: string; body: string }
  | { type: "input"; ptyId: string; data: string };

export function sendInputMessage(ptyId: string, data: string, appendEnter: boolean): SendInputMessage {
  // Only CR is Enter. Claude and Codex insert a newline for LF instead of submitting.
  if (appendEnter && !data.endsWith("\r")) {
    return { type: "mobile_submit", ptyId, body: data };
  }
  return { type: "input", ptyId, data };
}
