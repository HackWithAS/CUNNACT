# CUNNACT V6 Deployment Guide

## 1. Firebase project
The included `.firebaserc` points the Firebase CLI at the `cunnact` project.

Login once:

```bash
firebase login
```

Deploy Firestore rules:

```bash
firebase deploy --only firestore:rules
```

The web app uses Firebase Authentication + Firestore. Images continue to use Cloudinary; Firebase Storage is not required by the application.

## 2. Vercel
Deploy the project root to Vercel. The included `vercel.json` rewrites `/u/:username` to the public profile handler.

```bash
vercel --prod
```

After deploying, verify a direct refresh works for:

```text
https://YOUR-DOMAIN/u/yourusername
```

## 3. CUNNACT ID setup
Existing users should open Profile and choose a unique CUNNACT ID such as:

```text
@hackwithas
```

The share URL becomes:

```text
https://YOUR-DOMAIN/u/hackwithas
```

## 4. Two-account test
Test with two real accounts:

- login/register
- profile photo
- CUNNACT ID creation
- New Chat by ID
- message request → accept
- real-time messaging on both devices
- typing
- delivered/read states
- reactions
- save/unsave
- delete-for-me / delete-for-everyone
- block/unblock
- online/offline + last seen
- public profile while logged out

## 5. Retention note
Retention is intentionally client-side in this web build. Cleanup runs on app/chat open, visibility return and a periodic timer. This is not a guaranteed server-side deletion mechanism. A trusted scheduled backend would be required for guaranteed expiration regardless of client activity.

## 6. Branding
The visual brand assets live under:

```text
assets/brand/
assets/icons/
```

The identity uses:

- Blue `#3B82F6`
- Purple `#8B5CF6`
- Cyan `#06B6D4`
- Dark Slate `#0F172A`

The frontend Firebase configuration contains only browser-safe Firebase web-app identifiers. Never add Firebase Admin credentials or the Cloudinary API Secret to this project.
