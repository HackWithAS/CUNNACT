# CUNNACT Group UI / Flow Pass

Reference-driven updates for the WhatsApp-style group flow.

## UI
- Chats sidebar now shows a group count beside the Groups filter.
- Group conversations remain in the existing CUNNACT navigation/desktop 3-column structure.
- Group info drawer now includes member list, admin role controls, add members, invite link, join requests, settings, leave group, plus WhatsApp-style secondary actions:
  - See member changes
  - Add/remove from favourites
  - Add to list
  - Export chat
  - Clear chat
  - Exit group
  - Report group
- Added a Member Changes dialog for group activity.

## Backend / Firebase
- Added `conversations/{conversationId}/groupEvents/{eventId}` audit entries for group creation, rename, add/remove member, role changes and member leave (best effort from the UI so the main action is not blocked by logging).
- Added secure Firestore rules for reading/creating group activity logs by group members only.
- Added a group report flow using the existing `conversations/{conversationId}/reports` subcollection.

## Verification
- `node --check` passes for `app.js` and `dashboard-v2.js`.
- `index.html` has no duplicate IDs.
- Live Firebase behavior was not executable in this environment; deploy rules and test the group flows in the real Firebase project before production use.
