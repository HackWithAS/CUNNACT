// User-search helpers, kept separate from app.js so search logic can grow independently.

export const normalizeSearch = (value) => String(value || "").trim().toLowerCase();

/** True if a user document matches a (already-normalized) search term, excluding `excludeUid`. */
export function matchesSearch(user, term, excludeUid) {
  if (user.uid === excludeUid) return false;
  if (!term) return false;
  return `${user.name || ""} ${user.email || ""}`.toLowerCase().includes(term);
}
