// Chat-domain helpers, kept separate from app.js so the bootstrap file stays small.

/** Deterministic id for a 1:1 conversation between two uids, order-independent. */
export const buildConversationId = (a, b) => [a, b].sort().join("_");

/** Short preview text for the sidebar chat list / conversation row. */
export function previewText(message, { isMine } = {}) {
  if (!message) return "No messages yet";
  const prefix = isMine ? "You: " : "";
  if (message.type === "image") return `${prefix}📷 Photo`;
  return `${prefix}${message.text || ""}`;
}
