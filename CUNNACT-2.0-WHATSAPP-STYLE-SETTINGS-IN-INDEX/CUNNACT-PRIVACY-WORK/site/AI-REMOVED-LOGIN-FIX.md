# CUNNACT cleanup

- Removed CUNNACT AI frontend UI/module and Cloud Function.
- Removed AI quota cleanup references.
- Fixed malformed extractFirstUrl regex in js/app.js.
- Fixed Firestore rules get() default-argument warning.
- AI provider keys/secrets are no longer required by this build.


## Hotfix after deployment
- Removed the duplicate `functions` export from `js/firebase.js`; it is already exported via `export const functions` and must not be re-exported in the named export list.
- Removed the duplicate `getDeviceSessionId` re-export from `js/security.js`; the function is already directly exported.
- Bumped service-worker cache from `cunnact-shell-v10` to `cunnact-shell-v11` so deployed JS cannot remain stuck in an old shell cache after the parser fix.
