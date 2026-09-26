# CUNNACT emergency syntax fix — 2026-09-24

Fixed the JavaScript syntax error in `js/app.js` at the chat export `Blob` constructor that caused:

`Uncaught SyntaxError: Unexpected token ')'`

The malformed nested array was replaced with a valid Blob payload. This allows the `js/app.js` module to parse so the dashboard/auth bootstrap can run again.

Also rewrote the security-device rendering function in `js/settings.js` to remove a malformed nested template expression found during a full JavaScript syntax scan.

Verification performed:
- All `site/js/*.js` files passed Node module syntax checks.
- Top-level HTML files were scanned for duplicate IDs; none found.
