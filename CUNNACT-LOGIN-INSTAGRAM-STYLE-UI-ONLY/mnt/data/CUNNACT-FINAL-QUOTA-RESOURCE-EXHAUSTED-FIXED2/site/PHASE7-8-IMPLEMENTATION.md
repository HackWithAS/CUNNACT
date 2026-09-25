# CUNNACT Phase 7–8 Implementation

## Phase 7
- Global search across connected chats, recent messages, people, public communities and public channels.
- Public profile visibility/discovery fields and required Firestore composite indexes.
- Search race protection and safe result rendering.

## Phase 8
- Last-seen, read-receipt and typing-indicator controls.
- Public/private profile visibility and discovery controls.
- App lock with PBKDF2 PIN hashing and visibility lock.
- Per-chat locking using the same app-lock PIN.
- Device session registration, listing, remote sign-out and security activity feed.
- Firebase SMS MFA enrollment/sign-in challenge plumbing. Requires Firebase Identity Platform/SMS MFA configuration.
- Disappearing-message expiration and View Once media with per-user opened state.
- Security activity feed and remote device/session visibility.
- Global search opens matching community/channel details directly.
- Block/report controls retained.

## Honest limitations
- End-to-end encrypted messaging is not fully migrated in this pass; implementing real E2EE requires a key-management/protocol migration that would affect message search, backups and multi-device sync.
- Native biometric/Face ID/fingerprint lock is not implemented as a separate factor in the web build; the app-lock PIN is the current cross-platform lock mechanism.
- Live Firebase/Cloudinary transactions and physical-device biometric/MFA tests must be performed after deployment.
