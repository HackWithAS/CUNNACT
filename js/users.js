// User-search helpers can be added here as the application grows.
// Kept separate so Claude or you can extend search without changing chat.js.
export const normalizeSearch = value => String(value || "").trim().toLowerCase();
