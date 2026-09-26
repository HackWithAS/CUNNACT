# CUNNACT Trace UI implementation

This update is a UI/UX pass based on the supplied WhatsApp Status screenshots and 33.4-second screen recording.

## Visible terminology
- Status navigation is labelled **Trace**.
- The creation action is **Leave a trace**.
- Personal item is **My trace**.
- Recent list is **Recent traces**.
- Composer/share action is **Share trace**.
- Status/privacy viewer labels use **Trace** terminology.

The Firestore collection remains `stories` intentionally so existing data and backend behavior are preserved.

## UI flow
1. CUNNACT nav rail -> Trace
2. Trace page opens as a dedicated sidebar + workspace, matching the supplied Status screen.
3. `+` opens Photos & videos / Text choice.
4. Choosing media or text opens a full-screen Trace composer.
5. Composer includes close, emoji, Aa text style, background palette, audience control, additional link/sticker/poll fields, media selection and share action.
6. Audience control opens a Trace privacy dialog with Everyone / Close friends / Only selected people and reuses the existing audience picker.
7. Trace viewer is full-screen with progress segments, previous/next controls, media/text/poll rendering and reply bar.

## Backend safety
No backend files were changed in this pass. In particular:
- `firestore.rules` unchanged
- `storage.rules` unchanged
- `functions/index.js` unchanged
- `functions/package.json` unchanged
- `js/app.js` unchanged
- `js/auth.js` unchanged
- `js/firebase.js` unchanged

No Firebase rules deployment is required for this UI-only update.

## Validation
- JavaScript syntax checks: pass
- Duplicate HTML IDs: none
- Required Trace DOM hooks: present
- `dashboard-v2.css` braces: balanced
