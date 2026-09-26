# New Chat Contact List Update

Implemented behavior:
- Opening **New chat** with an empty search now shows existing 1:1 connections first under **Your contacts**.
- Groups are excluded from this contact list.
- Contacts are sorted with pinned conversations first, then by latest conversation activity.
- Clicking **Open chat** opens the existing conversation directly without sending a new request.
- Typing into the search field switches the modal to live user search for new connections.
- Existing connected users found through search show **Open chat**.
- Pending outgoing requests show **Cancel request**.
- New users show **Send request**.
- Search rendering is protected against stale async results overwriting newer searches.
