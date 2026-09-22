// User-search helpers with privacy-first 6-character minimum

export const normalizeSearch = (value) => String(value || "").trim().toLowerCase();

export const SEARCH_MIN_LENGTH = 6;

export function isSearchValid(term) {
  return term && term.length >= SEARCH_MIN_LENGTH;
}

export function getSearchMessage(term) {
  if (!term) return "";
  if (term.length < SEARCH_MIN_LENGTH) {
    return `Enter at least ${SEARCH_MIN_LENGTH} characters to search.`;
  }
  return "";
}

/** True if a user document matches a (already-normalized) search term, excluding `excludeUid`. */
export function matchesSearch(user, term, excludeUid) {
  if (user.uid === excludeUid) return false;
  if (!term) return false;
  
  // Prioritize email matching
  const email = (user.email || "").toLowerCase();
  if (email.includes(term)) return true;
  
  // Then name matching
  const name = (user.name || "").toLowerCase();
  if (name.includes(term)) return true;
  
  return false;
}

/** Search specifically for email matches (stricter matching) */
export function matchesEmail(user, term, excludeUid) {
  if (user.uid === excludeUid) return false;
  if (!term) return false;
  
  const email = (user.email || "").toLowerCase();
  return email.includes(term);
}
