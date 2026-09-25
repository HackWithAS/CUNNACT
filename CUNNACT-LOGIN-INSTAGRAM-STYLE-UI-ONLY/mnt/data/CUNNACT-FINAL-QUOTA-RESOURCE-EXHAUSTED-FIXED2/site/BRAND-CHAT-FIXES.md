# CUNNACT — Brand + Chat Stability Pass

This pass is focused on the reported UI/UX and chat loading issues.

## Fixed
- Rebuilt CUNNACT brand SVGs to use only the official palette: `#3B82F6`, `#8B5CF6`, `#06B6D4`, `#0F172A`, `#F8FAFC`.
- Regenerated favicon and PWA icon PNGs from the same brand mark.
- Removed the desktop sidebar's duplicate full wordmark/icon treatment; the rail owns the icon on desktop while the wider sidebar uses a text lockup.
- Fixed theme-logo CSS so the light and dark wordmarks cannot both display.
- Kept the desktop narrow-rail New Chat / Requests / Saved controls while retaining the wider controls on smaller layouts.
- Forced chat header 3-dot actions to remain visible in light and dark themes.
- Made the message listener more resilient: browser-side ordering, error UI, retry action, listener timeout recovery, and less aggressive conversation-preview writes.

## Backend scope
No Firebase rules, Auth, Firestore schema, or Cloudinary configuration was changed in this pass.
