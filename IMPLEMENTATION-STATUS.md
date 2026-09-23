# CUNNACT implementation status — 23 Sep 2026

## Completed in this pass

### Foundation / stability
- Strengthened first-load chat handling by merging an un-ordered Firestore fallback slice for small/legacy conversations whose records may omit `createdAt`.
- Kept the existing timeout + retry path and realtime listener cleanup.

### Messaging foundation
- Message edit flow with a 15-minute client/rules guard.
- Forward one or multiple selected messages to another existing conversation.
- Per-user message pin/unpin (`pinnedBy`).
- Message details modal.
- Multi-select mode with bulk delete-for-me and save/forward actions.
- In-conversation search over currently loaded history.
- Emoji insertion palette.
- Built-in lightweight sticker palette.
- Voice-note recording using MediaRecorder and a generic Cloudinary upload helper.
- Rendering support for audio/video/document/sticker message records created by the new message model.

## Existing and preserved
- Google/email authentication + verification
- Message requests
- Direct chat / groups
- Reactions
- Save / delete / reply
- Presence + typing + delivery/read state
- Cloudinary image upload
- Desktop New Chat -> Create group
- Mobile New group option

## Requires external/live setup or later phases
- Cloudinary unsigned preset must permit `auto` uploads before audio/video/document uploads can work live.
- GIF search provider/API integration is not yet added; GIF files can already be selected through the existing image picker.
- Calls, stories, communities, channels, global discovery, advanced privacy/security, AI, multi-device/device management, backup, and final security/performance audit remain later phases.

## Validation
- `node --check` passes for all JS files.
- `index.html` currently has no duplicate element IDs.
