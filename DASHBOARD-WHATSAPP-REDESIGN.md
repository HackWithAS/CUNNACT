# CUNNACT Dashboard — WhatsApp-style redesign

Implemented against the supplied CUNNACT project without replacing its Firebase/Cloudinary architecture.

## UI changes
- Reworked the desktop shell into a two-panel messaging layout.
- Removed the separate top command bar and left navigation rail from the desktop dashboard view.
- Expanded the conversation list into a WhatsApp-like left pane with a compact header, search, filters, status strip and larger chat rows.
- Reworked the chat header and composer into a messaging-app layout.
- Kept CUNNACT branding instead of copying WhatsApp branding.
- Preserved existing DOM IDs/classes used by `app.js`, requests, calls, social, search and chat code.
- Added responsive behavior so mobile keeps the existing `chat-open` navigation model.

## Functional safety
- No Firebase configuration was changed.
- No Firestore data model was changed.
- No Cloudinary configuration was changed.
- No existing request/chat/call functions were replaced by the visual redesign.

## Validation
- JavaScript syntax checked with Node for all project JS files and Cloud Functions index.
- `index.html` parsed successfully with Python's HTML parser.
- Live Firebase/Cloudinary/WebRTC behavior cannot be verified from this offline build environment.
