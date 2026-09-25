# CUNNACT Phase 3 + 4 — Implementation Notes

## Phase 3 — Groups
- Group creation keeps the existing mobile Group action and desktop New Chat -> Create group action.
- Group documents now track admins, moderators, roles, description and invite-link join approval.
- Admins can add/remove members and assign Member/Moderator/Admin roles.
- Group invite links are stored as revocable invite documents and are also rendered as QR codes using QuickChart's QR endpoint.
- Invite-link joining supports either an admin approval request or direct join when approval is disabled.
- Mentions are extracted from group text using member usernames; `@everyone` is stored as a group mention flag.
- Polls and events are real Firestore message types with vote updates.
- Group message reporting is stored in a protected reports subcollection. Group admins/moderators can moderate by soft-deleting messages.
- Group media/files/links continue to use the Phase 2 message/media pipeline.

## Phase 4 — Calls
- 1:1 voice/video calls and group calls use browser WebRTC with Firestore signaling.
- Group calls are capped at 8 participants to keep the browser mesh practical.
- Call links use the current CUNNACT page plus `call` and `conversation` query parameters. Access is restricted by Firestore rules to call participants who are also conversation members.
- Call history is stored in `conversations/{conversationId}/calls`.
- In-call controls: mute, camera, screen sharing, reaction, raise hand, PiP and leave/end.
- Browser notification is used for incoming calls when permission has already been granted.
- Microphone capture requests echo cancellation, noise suppression and auto gain control.

## Deployment notes
- Deploy the updated Firestore rules before using group invites, group role changes, polls/votes, reports or calls:
  `firebase deploy --only firestore:rules`
- WebRTC uses public Google STUN servers by default. For reliable production calling across restrictive NAT/mobile networks, configure TURN servers through `window.CUNNACT_TURN_SERVERS` before deployment. Without TURN, some networks may fail to establish peer-to-peer media.
- The invite QR uses an external QR image endpoint; an in-app QR generator can replace it later for fully self-contained/offline behavior.
