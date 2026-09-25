# CUNNACT Implementation Status

Phase 0: complete in previous build.
Phase 1: complete in previous build.
Phase 2: complete in previous build.
Phase 3: implemented in this build.
Phase 4: implemented in this build.

### Phase 3 implemented
- Group roles/admins/moderators
- Invite link + QR
- Join requests / approval and optional direct invite join
- Member controls
- Mentions and @everyone metadata
- Group polls and events
- Group reports and moderator message removal
- Group settings/description/photo

### Phase 4 implemented
- 1:1 voice/video WebRTC
- Group WebRTC mesh calls (up to 8)
- Call links
- Call history
- Screen share
- Mute/camera controls
- Call reactions and raise hand
- Picture-in-picture
- Incoming call UI/browser notification

### External setup / limitations
- Firestore rules must be deployed.
- Browser WebRTC may require TURN for some networks.
- Group call participant cap is 8.
- QR rendering currently depends on an external QR image endpoint.
