# CUNNACT — Stay Connected

CUNNACT is a real-time one-to-one messaging web application built with Vanilla JavaScript, Firebase Authentication/Firestore and Cloudinary for images.

## Highlights

- Real-time one-to-one messaging
- Message requests before first contact
- Unique CUNNACT IDs (`@username`)
- Shareable public profiles (`/u/:username`)
- Online/offline + last seen presence
- Typing indicator
- Sent / delivered / read states
- Message reactions
- Save / unsave messages
- Delete for me / delete for everyone
- Block / unblock
- 24-hour or after-seen retention
- Cloudinary image sharing
- Dark/light mode
- Sound effects with a global toggle
- Responsive desktop and mobile UX
- Original CUNNACT brand mark, favicon and app icons

## Visual identity

CUNNACT uses a restrained blue/purple/cyan system:

- Blue: `#3B82F6`
- Purple: `#8B5CF6`
- Cyan: `#06B6D4`
- Dark Slate: `#0F172A`

Brand assets are under `assets/brand/` and `assets/icons/`.

## Project layout

```text
index.html
landing.html
login.html
register.html
profile.html
public-profile.html
js/
css/
assets/
firestore.rules
firebase.json
vercel.json
.firebaserc
manifest.webmanifest
```

## Quick start

Serve the folder from a local web server because Firebase ES modules should not be loaded from `file://`:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/login.html
```

## Deploy

Firebase rules:

```bash
firebase login
firebase deploy --only firestore:rules
```

Vercel:

```bash
vercel --prod
```

## Public profile links

A user can share:

```text
Connect with me on CUNNACT:
@hackwithas
https://YOUR-DOMAIN/u/hackwithas
```

Public profiles intentionally expose only public identity fields, not email or private account settings.

## Important limitations

Message retention cleanup is client-side in this build. For guaranteed server-side expiration, a trusted scheduled backend would be required.

Voice/video buttons are presented as product UI placeholders; no call signaling/media server is claimed as implemented.

## Testing

Every JavaScript file in this deliverable passes Node syntax validation. The final two-device Firebase flow still needs to be exercised against your live Firebase/Vercel deployment.

Created by HackWithAS.

## V6 UI navigation + brand correction

- On large desktop layouts (>1100px), New Chat, Requests, and Saved Messages are available from the narrow navigation rail only; the wider conversation sidebar keeps the existing mobile/tablet controls.
- On tablet/mobile layouts, the existing wider sidebar controls remain visible as before.
- CUNNACT uses a single shared brand identity across app icon, favicon, authentication, landing, profile, public profile, and in-app welcome surfaces.

## Current implementation status

This deliverable includes the implemented messaging foundation from earlier phases plus Phase 3 groups/calls and the new Phase 5–6 social layer:

- 24-hour stories/status with photo/video/text, stickers, links, polls, audience controls, replies, reactions and viewer tracking.
- Communities with public/private visibility, rules, moderators, member management, private join requests, sub-groups and an automatic announcement channel.
- Channels with public/private visibility, followers, admin posting, media, polls, reactions and comments.
- Discovery/search surfaces for stories, communities and channels.
- Scheduled server cleanup for expired stories via Cloud Functions.

Earlier authentication, requests, messaging, groups, calls and Cloudinary features remain in the same codebase. Live Firebase/Cloudinary behavior still requires deployment and testing against the project's services.
