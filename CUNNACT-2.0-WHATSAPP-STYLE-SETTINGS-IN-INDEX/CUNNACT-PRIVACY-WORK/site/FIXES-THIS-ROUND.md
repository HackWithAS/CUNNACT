# CUNNACT — fixes applied (this round)

## Fixed
1. **Duplicate brand name on desktop** — a leftover `!important` rule was forcing the mobile
   logo image to render even on desktop widths, stacking it next to the text wordmark.
   Fixed in `css/chat.css` with a correctly-scoped override.
2. **Missing 3-dot account menu on desktop** — same root cause as #1: the oversized
   duplicate logo image was pushing the account menu button out of the header. Fixed by
   the same CSS change, plus an explicit "always visible" rule for the button.
3. **Online / offline colors** — presence dot and "Active now" pill are now green when
   online and red when offline (`css/chat.css`).
4. **Email privacy leak** — other users could see your email address in: New Chat search
   results, incoming message-request cards, and via the stored request document. All three
   are fixed; only `@username` is ever shown to anyone but you. (`js/app.js`, `js/requests.js`)
5. **Clear chat** — added to the conversation's 3-dot menu. Removes all messages from your
   view only (like WhatsApp's "clear chat"), in batches, without deleting them for the other
   person. (`js/app.js`)
6. **Pin chat / Delete chat** — long-press (touch) or right-click (desktop) a conversation in
   the sidebar to pin it to the top or delete it from your list. Requires the matching
   `firestore.rules` update included here (adds `pinned` / `hiddenFor` as allowed fields on a
   conversation document, still gated to conversation members only).
7. **Animated splash screen** — the loading screen now assembles the actual CUNNACT mark
   piece-by-piece with a soft pulse, then fades in "CUNNACT" / "Stay Connected." — replacing
   the generic spinner. (`index.html`, `css/animations.css`)
8. **Username-first registration** — Register now asks for your CUNNACT ID (username) up
   front, checks availability before the account is even created, and email is clearly
   labeled "for login only — never shown to others." (`register.html`, `js/auth.js`)
9. **Forgot password** — added a working "Forgot password?" link on the login page using
   Firebase's password-reset email. (`login.html`, `js/auth.js`)
10. **Mandatory email verification** — after registering, a verification email is sent and
    the app now blocks access behind a "verify your email" screen (with resend / re-check /
    log out) until the address is confirmed. This stops most throwaway/typo email signups —
    it does not block real disposable-email services, which would need a domain blocklist.
    (`js/auth.js`, `js/app.js`, `js/firebase.js`)

## Needs your input before I build it
- **"You have not assessed" error when sending a request** — I searched the entire
  codebase for this exact string and every request-related error path, and nothing matches
  it. Please send a screenshot or the exact text next time you hit it — it may be a raw
  Firebase error surfacing rather than an app string, and I'd rather fix the real cause than
  guess.
- **"Group" option** — full group chat is a new data model (N members, not 2), new
  `firestore.rules`, new message routing, group admin/membership UI. It's a real feature
  project on its own, not a menu-item edit. Tell me if you want this scoped next and I'll
  design it properly rather than bolt on a fake button.

## Round 2 (per your feedback)
- **Reverted to the hard email-verification gate** (blocks access until verified), now with an
  explicit "check Spam/Promotions" note on the screen itself.
- **Added "Sign in with email link" (passwordless / magic link)** on the login page. Since
  Firebase only lets someone in this way by actually clicking a link sent to that address,
  it auto-marks the email as verified — no separate verification step for people who use it.
  This needs "Email link (passwordless sign-in)" enabled in Firebase Console → Authentication
  → Sign-in method, which you said you've already turned on.
- If someone uses the email-link button with an email that has no CUNNACT account yet,
  Firebase will sign them in as a new user automatically (that's how passwordless auth works).
  To stop that from creating a broken, username-less account, they now land on a small
  "pick your CUNNACT ID" box right there on the login page before they can enter the app.
- **APK**: still not built — see the note above about why a real compiled `.apk` needs an
  Android SDK/Gradle environment this sandbox doesn't have. Say the word and I'll put together
  the full Capacitor Android project next (source + build instructions), which you can build
  from a Windows/Mac/Linux machine with Android Studio, or I can guide you through the exact
  commands if you have one.

## Round 3 — Group chat + Google Sign-In + bug fixes

### Group chat (new feature)
- **New group** button next to New chat in the sidebar. Groups are built from people you
  already have a 1:1 chat with (keeps the "no arbitrary full user search" rule from the
  original spec).
- Group chat header shows the group name + member count instead of online status.
- Messages from other members show a small sender-name label (like WhatsApp groups).
- Group info panel (tap the group name/photo or 3-dot → Group info): member list, remove
  member / add members (admins only), rename group (admins only), leave group (anyone).
- Clear chat / Pin / Delete-from-my-list all already work on groups too, no changes needed.
- **Known v1 simplification**: no per-member "seen by" read receipts in groups — group
  messages just show a single sent tick, not delivered/read. Doing per-member receipts
  properly is a bigger job I've deliberately deferred; shout if you want it next.
- `firestore.rules` was significantly extended for this (group creation, admin-gated
  membership changes, group messages). **This is security-critical code I can't test against
  a live Firestore emulator from here** — please try it in the Firebase Console's Rules
  Playground, or just test the group flows for real, before fully trusting it in production.

### Google Sign-In
- Added "Continue with Google" on the login page.
- First-time Google sign-in still lands on the same "pick your CUNNACT ID" box as email-link
  sign-in (Google accounts are inherently verified, so no separate email-verify step).
- That box now also offers an **optional** "set a password" field, so a Google-only account
  can later log in with email + password too (uses Firebase's account-linking).
- **This needs "Google" enabled as a Sign-in provider in Firebase Console → Authentication →
  Sign-in method**, and your domain(s) listed under Authorized domains there.

### Bug fixes
- **New Chat search icon position** — the search icon was sitting outside the input box
  instead of inside it, because the modal's search wrapper had its own left padding that
  wasn't accounted for in the icon's absolute positioning. Fixed in `css/chat.css`.

### On the "Firebase connection breaking" / "chats not loading" reports
I don't have access to your live Firebase console from here, so I can't see the actual error.
Things worth checking, roughly in order of likelihood:
1. **Did the updated `firestore.rules` from this project actually get published to your live
   Firebase project?** (Firebase Console → Firestore Database → Rules tab → paste → Publish,// or `firebase deploy --only firestore:rules` if you use the CLI.) I've changed these rules
   several times this session — if the live project is still running an older version, several
   features here will throw `permission-denied`, which can look like "the connection broke."
2. Open the browser DevTools Console on the live site while it's stuck, and check for the
   exact error — `permission-denied`, `unavailable`, `quota-exceeded` etc. all mean different
   things and I can fix precisely once I know which one it is.
3. Firebase Console → Authentication → Settings → Authorized domains — make sure your actual
   domain (e.g. `cunnact.vercel.app`) is listed, not just `localhost`.
4. **Cloudinary is not related to this** — it only stores uploaded images (profile photos,
   shared pictures). Chat messages, usernames, requests etc. all live in Firestore, not
   Cloudinary, so anything you see in `console.cloudinary.com` is separate from chat
   loading/connection issues.
