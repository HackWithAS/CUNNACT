# CUNNACT — Deployment & Verification Guide

## What was fixed in this build

This build fixes the runtime failure that could leave the dashboard visible but make its controls non-functional. The Firestore `deleteDoc` export is now present, the app has a protected auth-loading gate, and the request/search/chat/modals are wired again.

The messaging logic was also tightened:

- Login/session bootstrap redirects signed-out users to `login.html` and loads the signed-in user's profile on the dashboard.
- Message requests are required before a new conversation can be created; declined requests can be sent again.
- Search starts only at 6 characters and uses email-prefix queries instead of loading an arbitrary list of users first, with a legacy email fallback.
- `Delete for me` marks only the current user's copy as deleted; it no longer deletes the shared Firestore message.
- `Delete for everyone` is sender-only and permanently deletes the message document.
- Read receipts are written to each incoming message, so `Delete after seen` can work.
- 24-hour retention is checked on app open, visibility changes, conversation open, and while a chat stays open.
- Saved messages are excluded from retention for the user who saved them.
- Retention preference is stored on the user's Firestore profile as well as locally.
- Saved Messages and Message Requests modals are now functional.
- Cloudinary remains the image host; no Cloudinary API Secret is stored in the browser.

## Deploy

From the project folder:

```bash
firebase login
firebase use cunnact
firebase deploy --only firestore:rules,hosting
```

Firebase Storage is not used by this version, so there is no need to deploy `storage.rules` for CUNNACT image uploads.

For Vercel, deploy the project folder as usual. The `.backup` source files were removed from this production folder.

## First test after deployment

1. Open the site in an Incognito/Private window.
2. You should see the CUNNACT login page when no session exists.
3. Create or use a test account.
4. Confirm the dashboard shows your name/avatar and the Logout button works.
5. Open Profile and confirm Save Changes returns to the chat.
6. Create a second test account and search using at least 6 email characters.
7. Send a request, accept it from the second account, and send messages both ways.
8. Right-click/long-press a message and test Save, Delete for me, and Delete for everyone.
9. Open Saved Messages and confirm a saved message appears.
10. Test both retention modes with test messages.

## Important retention limitation

Retention is client-side in this build. The app checks for expired messages when a user opens/refreshes the app, changes visibility, opens a chat, or while a chat remains open. A message is not guaranteed to be removed while every client is closed/offline.

A server-side scheduled deletion system would require backend/server infrastructure beyond this static frontend.

## Safe Browsing warning

A source-code inspection cannot establish why Google Safe Browsing or a browser warning was triggered. Do not treat the warning as fixed merely because the code was changed. Use Google's Safe Browsing/Search Console review tools and the hosting provider's diagnostics to verify the domain status.
