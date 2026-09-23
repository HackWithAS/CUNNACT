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
