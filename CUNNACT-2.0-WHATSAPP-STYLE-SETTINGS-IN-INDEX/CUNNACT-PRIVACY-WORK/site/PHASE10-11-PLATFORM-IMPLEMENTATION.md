# CUNNACT Phase 10–11 platform implementation

## Web
- Device/session registration and remote sign-out are implemented in `js/security.js` and `index.html (in-place Settings)`.
- Foreground/background push notification plumbing is implemented with FCM in `js/notifications.js` and `firebase-messaging-sw.js`.
- Offline state banner, service-worker shell caching, keyboard shortcuts, drag/drop media and clipboard image paste are implemented.
- Desktop chat pop-out opens an isolated CUNNACT chat window using a `conversation` deep-link.

## Android
The existing Capacitor Android project should consume the same Firebase/Firestore user, conversation and device-session model. Native FCM token handling should write to the same `users/{uid}.fcmTokens` array or, preferably in a later hardening pass, migrate to a dedicated device-token collection. The release APK/AAB must keep the same Firebase Android app registration and signing certificate.

## Windows / Tauri
The existing Tauri build can use the same deep links, Firestore device sessions, and conversation routing. System tray, native notifications and window controls remain platform-layer integrations rather than web-only code. The web build is prepared for those integrations without adding platform-specific secrets.

## Backup / restore
`js/account.js` provides a portable JSON backup/export. Restore is intentionally account-bound and only recreates messages originally authored by the currently signed-in CUNNACT account in conversations that still exist and still include that account. Other participants' messages are not recreated.

## Account deletion
`deleteMyAccount` in `functions/index.js` removes Firebase Authentication, public profile/preferences, user-owned requests, stories, devices, security activity, owned content, and authored messages. Shared conversations are retained with a minimal `Deleted account` identity so other participants do not end up with broken references; group/community/channel ownership is transferred when possible.
