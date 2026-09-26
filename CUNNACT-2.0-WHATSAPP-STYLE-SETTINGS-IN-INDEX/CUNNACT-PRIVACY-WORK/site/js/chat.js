// Chat-domain helpers, kept separate from app.js so the bootstrap file stays small.

/** Deterministic id for a 1:1 conversation between two uids, order-independent. */
export const buildConversationId = (a, b) => [a, b].sort().join("_");

/** Short preview text for the sidebar chat list / conversation row. */
export function previewText(message, { isMine } = {}) {
  if (!message) return "No messages yet";
  const prefix = isMine ? "You: " : "";
  if (message.type === "image") return `${prefix}📷 Photo`;
  if (message.type === "gif") return `${prefix}GIF`;
  if (message.type === "audio") return `${prefix}🎤 Voice message`;
  if (message.type === "video") return `${prefix}🎬 Video`;
  if (message.type === "document") return `${prefix}📄 ${message.fileName || "Document"}`;
  if (message.type === "contact") return `${prefix}👤 ${message.contactName || "Contact"}`;
  if (message.type === "location") return `${prefix}📍 Location`;
  if (message.type === "sticker") return `${prefix}${message.text || "✨"}`;
  return `${prefix}${message.text || ""}`;
}
