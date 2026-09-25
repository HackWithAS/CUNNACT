export const SEARCH_MIN_LENGTH = 6;

export function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

export function isSearchValid(term) {
  return !!term && term.length >= SEARCH_MIN_LENGTH;
}

export function getSearchMessage(term) {
  if (!term) return "";
  if (term.length < SEARCH_MIN_LENGTH) {
    return `Enter at least ${SEARCH_MIN_LENGTH} characters to search.`;
  }
  return "";
}

export function matchesSearch(user, term, excludeUid) {
  if (!user || user.uid === excludeUid || !term) return false;
  const email = String(user.email || "").toLowerCase();
  const name = String(user.name || "").toLowerCase();
  return email.startsWith(term) || name.startsWith(term);
}

export function matchesEmail(user, term, excludeUid) {
  if (!user || user.uid === excludeUid || !term) return false;
  return String(user.email || "").toLowerCase().startsWith(term);
}
