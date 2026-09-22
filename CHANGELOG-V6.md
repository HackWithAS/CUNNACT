# CUNNACT V6 — Complete Upgrade

## Product/UI
- Original CUNNACT logo mark, app icon and favicon applied across the product.
- Brand palette standardized around Blue `#3B82F6`, Purple `#8B5CF6`, Cyan `#06B6D4`, and Dark Slate `#0F172A`.
- Light/dark theme accents, buttons, focus states, chat accents and profile accents updated to the CUNNACT identity.
- Premium 3-column desktop shell with navigation rail, conversation list, active chat and contact drawer.
- Rebuilt responsive Profile experience with stable field layout, avatar camera overlay and shareable ID.
- Added public-profile presentation and a dedicated landing page.
- Mobile message menus use a bottom-sheet treatment.

## Identity & Sharing
- Unique CUNNACT ID (`@username`) with transaction-protected username mapping.
- Public profile documents expose only public fields.
- Share via Web Share API or copy ID/link.
- `/u/:username` routes configured for Vercel/Firebase hosting.

## Messaging
- Stable single conversation listener with incremental `docChanges()` DOM reconciliation.
- Batched delivered/read receipts.
- Visible-message read observation via IntersectionObserver.
- Typing indicator with debounced presence writes.
- Message reactions.
- Save/unsave with a per-user saved-message index.
- Delete-for-me uses `deletedFor`; delete-for-everyone is sender-only.
- Custom in-app confirmation modal; no browser `alert()`, `confirm()` or `prompt()`.
- Image attachments retained through Cloudinary.

## Presence
- Heartbeat-based online/offline calculation.
- Local stale-status recalculation so an old `isOnline` value cannot remain visible as Online forever.
- Visibility, browser online/offline and page lifecycle hooks.

## Security
- Conversation creation is gated by an accepted message request.
- Public profile/private settings separation.
- Protected username ownership and block lists.
- Field-level restrictions for reactions, read/delivery state, saved state and delete-for-me.

## Validation
- All JavaScript files pass `node --check` syntax validation.
- HTML IDs checked for duplicates.
- Browser alert/confirm/prompt calls removed.
- No backup files are included in the production project.

## V6 fixes
- Removed duplicated Requests, Saved Messages, and New Chat controls from the narrow navigation rail; these remain as the primary controls in the main sidebar/conversation header.
- Acceptance flow now updates the request first and creates the deterministic conversation under a simpler Firestore authorization path.

### Final UI correction
- Corrected CUNNACT brand assets to the approved blue/purple/cyan C mark + chat-dot identity.
- Added desktop navigation rail actions for New Chat, Requests, and Saved Messages.
- Kept the existing wider sidebar actions visible on tablet/mobile.
- Removed those wider sidebar action controls from large-desktop presentation to avoid duplicate dashboard/sidebar options.
- Kept backend/Firebase/Cloudinary behavior unchanged apart from the existing UI request badge wiring.
