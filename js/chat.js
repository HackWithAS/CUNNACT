// Advanced chat features such as reactions, replies, read receipts and file messages
// can be added here without changing the main application bootstrap.
export const buildConversationId = (a, b) => [a, b].sort().join("_");
