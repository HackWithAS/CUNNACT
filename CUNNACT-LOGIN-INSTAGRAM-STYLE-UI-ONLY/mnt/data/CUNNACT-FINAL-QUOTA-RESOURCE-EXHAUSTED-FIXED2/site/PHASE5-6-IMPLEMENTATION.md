# CUNNACT Phase 5–6 implementation

## Phase 5 — Stories / Status
- 24-hour stories with expiration timestamp
- text, image, video, stickers, links and polls
- public / close-friends / selected-audience controls
- story viewer navigation
- story replies
- story reactions
- viewer tracking
- server-side cleanup function (`purgeExpiredStories`)
- Firestore composite indexes for active-story queries

## Phase 6 — Communities & Channels
- public/private communities
- community descriptions and rules
- owners/admins/moderators/member lists
- private join requests with approval/rejection
- sub-groups backed by the existing group chat model
- automatic announcement channel on community creation
- public/private channels
- followers/subscribers
- admin-only channel posts
- channel media posts
- channel polls and reactions
- channel comments
- discovery/search for communities and channels

## Notes
These features are implemented in the web codebase. Firebase rules and indexes are included in this package but must be deployed to the live Firebase project. Cloud Functions deployment is also required for scheduled story cleanup.
