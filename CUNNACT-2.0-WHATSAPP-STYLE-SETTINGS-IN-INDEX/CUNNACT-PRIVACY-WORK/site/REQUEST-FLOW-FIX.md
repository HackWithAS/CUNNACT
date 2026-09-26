# CUNNACT Request Flow Fix

## What changed

- Added live tracking of outgoing pending message requests.
- New Chat search now shows **Cancel request** for a request that is still pending.
- Cancelling deletes the pending request so the recipient's request list updates immediately and a fresh request can be sent later.
- Sending a request now checks the canonical request document before attempting a write, avoiding an accidental full overwrite of an existing request.
- Firestore rules now allow the sender to delete a request only while it is pending.
- Contact eligibility now recognizes a complete `users/{uid}` record or a public profile, which helps older/partially migrated CUNNACT accounts.
- Error messages distinguish Firebase permission rejection from network/index failures.

## Required Firebase step

The updated `firestore.rules` MUST be deployed to the Firebase project used by CUNNACT. Vercel deployment does not deploy Firestore rules.

Run from this project root after Firebase CLI authentication:

```bash
firebase deploy --only firestore:rules
```

Then refresh CUNNACT and test:

1. Search another CUNNACT user.
2. Send request.
3. Re-open/search that same user; button should say **Cancel request** while pending.
4. Cancel request; button should return to **Send request**.
5. Confirm recipient no longer sees that request.
6. Send a new request again.
7. Recipient accepts/declines and both sides update correctly.
