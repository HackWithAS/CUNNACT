# CUNNACT V6

- Rebuilt profile page layout and responsive form.
- Added a single-source avatar renderer that never displays photo + initials together.
- Added heartbeat-based online/offline calculation with periodic UI refresh.
- Added CUNNACT ID (`@username`) with uniqueness mapping.
- Added public profiles at `/u/:username` with Vercel rewrite support.
- Added Web Share API / copy-link profile sharing.
- Added CUNNACT ID lookup to New Chat.
- Added public-profile privacy separation.
- Added message reactions.
- Added typing indicator with debounced presence writes.
- Improved visible-only read marking.
- Kept custom confirmation dialogs and removed browser confirmation flows.
