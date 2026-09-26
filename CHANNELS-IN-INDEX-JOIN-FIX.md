# Channels in-index + Join fix

- Main Channels UI remains inside `index.html`; there is no separate `channels.html` route/file.
- Removed the duplicate legacy Channels tab from the social hub so the main navigation has one Channels experience.
- Public channels can be searched from the Channels sidebar and joined with the Join button.
- Channel membership updates use the existing `subscriberIds` field.
- Public channel discovery and the current user's own channels use Firestore reads and live `onSnapshot` refreshes so a newly-created public channel can appear on another signed-in device without manually reloading.
- Channel list shows Owner / Joined / Join / Private membership state.
- Channels workspace has light-theme overrides for the full sidebar, main header, posts, menus and controls.
- Firestore rule change: signed-in users can add/remove only themselves from `subscriberIds` on public channels; owners/admins retain channel management permissions.
