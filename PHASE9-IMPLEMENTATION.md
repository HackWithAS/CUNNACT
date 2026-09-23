# CUNNACT Phase 9 — AI implementation

## Implemented
- CUNNACT AI modal with explicit per-user consent.
- Ask AI with the active conversation context.
- Conversation summary.
- Unread-message summary (based on readBy/receiver state visible to the client).
- Group summary.
- Smart reply generation.
- AI-assisted poll generation with one-click handoff into the existing group-poll composer.
- Translation with language selector.
- Rewriting with tone selector.
- Grammar correction.
- Cloudinary image understanding.
- Cloudinary document summarization.
- Browser voice recording -> server-side speech-to-text.
- Chat menu shortcuts for Ask AI, Summarize and Smart replies.
- Mobile-accessible account-menu AI entry.
- No private chat content is persisted by the AI Cloud Function.
- Authenticated Cloud Function + explicit consent gate + 30 calls/user/day quota.
- AI provider secret stays in Firebase Functions only.

## Backend setup
1. Add the OpenAI API key as a Firebase Functions secret:

   `firebase functions:secrets:set OPENAI_API_KEY`

2. Optional model override can be supplied as a Functions environment variable. The default is `gpt-5.6-luna`.
3. Deploy the AI callable function:

   `firebase deploy --only functions:cunnactAI`

4. Ensure the Cloudinary `cunnact_uploads` preset allows the file types users want to analyze.

## Notes
- The AI panel intentionally requires user consent before any conversation/file/image content is sent to the server.
- The function validates Cloudinary URLs before passing media to the model.
- Live provider billing/API transactions cannot be exercised from this development environment; after deployment, test each action with a real signed-in account.
- Real end-to-end encryption is not claimed by this phase; AI processing occurs only on content the user explicitly requests to analyze.
