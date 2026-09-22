# CUNNACT V6 Deployment

## Firebase
Deploy the updated Firestore rules from `firestore.rules`:

```bash
firebase deploy --only firestore:rules
```

## Vercel
Deploy the project root. `vercel.json` rewrites `/u/:username` to `public-profile.html`.

## Test after deployment
1. Sign in with two accounts.
2. Set a unique CUNNACT ID in Profile.
3. Open `https://YOUR-DOMAIN/u/username` in an incognito window.
4. Verify only public fields are shown.
5. Test New Chat using `@username`.
6. Test profile photo on sidebar, chat header and profile page.
7. Close one account and verify the other becomes Offline after the heartbeat window.
8. Test message send, read, save, delete and reactions on two devices.

Client-side retention cleanup is not a guaranteed server-side deletion mechanism; use a trusted scheduled backend if hard server-side expiration is required.
