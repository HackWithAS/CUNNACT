# CUNNACT — Deep Audit & Fixes

Date: 2026-09-23

## Fixed in this pass

- Removed the **Sign in with email link** button from Login. Google sign-in remains.
- Removed the unused Firebase passwordless-email-link flow from the frontend.
- Registration now clearly shows **Verify with email link** beneath the email field and the primary action explicitly says **Create account & send verification link**.
- Registration still uses Firebase email verification; the existing verification gate, resend, re-check and logout flow remains intact.
- Chat message loading now asks Firestore for the **newest 100 messages** using `createdAt desc`, then renders them oldest-to-newest. A legacy-data fallback remains if some records do not have `createdAt`.
- Request sending now distinguishes between **already sent**, **incoming pending request**, **accepted/connected**, and a newly sent request, so the UI no longer silently falls back to `Send request` after a duplicate/pending request.
- Username validation is consistent at **3–24 characters** across registration, profile editing and chat search.
- Group message receipt fields are authorized in Firestore for group members as well as direct-message receivers.
- Added friendlier Firebase Auth errors for disabled providers and unauthorized domains.

## Static checks completed

- All JavaScript files pass `node --check` syntax validation.
- All HTML pages were checked for duplicate element IDs; none were found.
- Firebase web configuration points to project `cunnact`.
- Cloudinary is configured with cloud `qfw2dy0h`, unsigned preset `cunnact_uploads`, HTTPS upload endpoint, image validation and a 5 MB limit.
- No Firebase Admin/service-account credential or Cloudinary API secret is present in the frontend source.
- Login no longer contains the passwordless email-link control or handler.

## Live-service limitation

This sandbox cannot establish outbound DNS/network connections to Firebase or Cloudinary, and the local browser runner is blocked from opening the local test server. Therefore this pass verifies the integration code, rules and configuration, but **does not claim a live Firebase/Cloudinary transaction succeeded**.

Before production deployment, test these real flows on the deployed domain:

1. Create account → receive verification email → open link → enter app.
2. Login with email/password.
3. Continue with Google.
4. Forgot password.
5. Search a user → send request → accept request → chat opens.
6. Send/receive text, reply, reaction, save, delete-for-me and delete-for-everyone.
7. Refresh a long chat and confirm the newest messages appear without an infinite loader.
8. Upload profile photo and chat image through Cloudinary.
9. Create/rename/use/leave a group.
10. Test mobile layout and reconnect after temporarily going offline.

## Firebase production checks

- Publish the included `firestore.rules` to the **cunnact** Firebase project.
- In Firebase Authentication, keep Email/Password enabled and Google enabled.
- Add every deployed hostname (including `cunnact.vercel.app` if that is the active deployment) to Firebase Authentication Authorized Domains.
- Confirm Firestore is enabled for the project.
- Confirm the Cloudinary unsigned upload preset `cunnact_uploads` still exists and accepts the intended image formats.
