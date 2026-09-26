# CUNNACT Gaming Zone — Online Multiplayer

Updated games:
- Chess — online friend rooms, computer, local 2-player
- Ludo — online friend rooms, computer, local 2-player
- Tic Tac Toe — online friend rooms, computer, local 2-player
- Connect 4 — online friend rooms, computer, local 2-player
- Checkers — online friend rooms, local 2-player
- UNO-style Cards — online friend rooms, computer, local 2-player
- Pong — computer/local only in this iteration
- Candy Crush — single-player match-3

Online rooms use Firestore `gameRooms` and `gameInvites`. A room link can be shared directly, or an online friend invite can be sent to a connected CUNNACT contact. Both users must be signed in.

After deploying this version, deploy the Firestore rules because `firestore.rules` contains the new `gameRooms` and `gameInvites` security rules.
