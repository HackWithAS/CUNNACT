// Tiny DOM helpers shared by app.js / profile.js / auth.js.

export const $ = (id) => document.getElementById(id);

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

export function formatTime(date) {
  return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

/** "Just now" / "5m ago" / "Yesterday" / "12 Jun" style, for chat list rows. */
export function formatWhen(date) {
  if (!date) return "";
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffMin < 60 * 24 && now.toDateString() === date.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** "last seen 5m ago" style text for a chat header subtitle. */
export function formatLastSeen(date) {
  if (!date) return "Offline";
  const diffMin = Math.floor((new Date() - date) / 60000);
  if (diffMin < 1) return "last seen just now";
  if (diffMin < 60) return `last seen ${diffMin}m ago`;
  if (diffMin < 60 * 24) return `last seen ${Math.floor(diffMin / 60)}h ago`;
  return `last seen ${date.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

export function debounce(fn, wait = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}
