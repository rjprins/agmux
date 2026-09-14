export type SendInputMessage =
  | { type: "mobile_submit"; ptyId: string; body: string }
  | { type: "input"; ptyId: string; data: string };

export function sendInputMessage(ptyId: string, data: string, appendEnter: boolean): SendInputMessage {
  // A trailing Enter written with the text lands inside Codex's paste burst as a newline,
  // so submits always go through the gated flow, which drops trailing line breaks.
  if (appendEnter) return { type: "mobile_submit", ptyId, body: data };
  return { type: "input", ptyId, data };
}
