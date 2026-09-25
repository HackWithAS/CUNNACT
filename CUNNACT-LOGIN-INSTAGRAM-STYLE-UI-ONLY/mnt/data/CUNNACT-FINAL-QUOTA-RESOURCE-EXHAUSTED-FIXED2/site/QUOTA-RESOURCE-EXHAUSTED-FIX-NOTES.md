# CUNNACT — Resource Exhausted / Startup Fix

## Root cause addressed
- `visibilitychange` referenced the removed `flushQueuedReads()` function, causing `ReferenceError` and preventing normal dashboard execution.
- The old per-message read queue path was removed in the optimized receipt implementation; visible messages now use the conversation-level receipt cursor.
- Auth bootstrap now tolerates a non-critical `resource-exhausted` profile read and continues with Firebase Auth user data instead of trapping the user behind the auth gate.
- Typing writes now enter a short cooldown after `resource-exhausted` so a user typing while Firestore is exhausted cannot generate a rapid retry storm.

## Verification
- All JS files syntax checked with `node --check`.
- No remaining `flushQueuedReads` reference.
- Duplicate HTML IDs checked.

## Important
`resource-exhausted` is a real Firestore service/quota response. Code changes reduce unnecessary writes and prevent retry storms, but a quota that is already exhausted on the Firebase project can still reject legitimate reads/writes until the quota becomes available again.
