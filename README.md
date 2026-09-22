# CUNNACT

**Stay Connected.**

A modern real-time one-to-one messaging web application built with HTML, CSS, JavaScript, Firebase and Cloudinary.

## Stack

- HTML5
- CSS3
- Vanilla JavaScript (ES modules)
- Firebase Authentication
- Cloud Firestore
- Cloudinary (image storage — profile photos and chat images)

Firebase Storage is **not** used. It isn't available on the free Firebase plan without
upgrading, so image uploads (profile photos and chat images) go straight to Cloudinary
using an unsigned upload preset, and only the resulting `secure_url` is saved to Firestore.

## Firebase setup

1. Create a project at the Firebase Console.
2. Add a Web App and copy its config into `js/firebase-config.js`.
3. Enable Authentication → Sign-in method → Email/Password.
4. Create a Firestore database.
5. Deploy rules:

   ```bash
   firebase login
   firebase use YOUR_PROJECT_ID
   firebase deploy --only firestore:rules
   ```

6. Run the site through a local web server (for example VS Code Live Server) — ES modules
   don't load from `file://`.
7. Deploy hosting when ready:

   ```bash
   firebase deploy --only hosting
   ```

The first time the app runs, Firestore may show a console link asking you to create a
composite index for the conversation list query (`members` array-contains + `lastMessageTime`
order). Click it once and the query will work from then on.

## Cloudinary setup

Configuration lives in `js/cloudinary.js` (cloud name and the **unsigned** upload preset —
both are safe to keep in frontend code). Nothing else to set up if the preset already
exists and is unsigned.

**Never** put a Cloudinary **API Secret** anywhere in this project. The frontend only ever
uses the cloud name and the unsigned preset, which is why deletion of old images isn't
done from the browser — that would need the secret. Old/replaced Cloudinary images are
simply not deleted (see Known limitations).

## Firestore structure

```text
users/{uid}
  name, email, bio, photoURL, isOnline, lastSeen, createdAt

conversations/{conversationId}          // id = sorted "uidA_uidB"
  members: [uidA, uidB]
  lastMessage, lastMessageType, lastMessageSenderId, lastMessageTime
  unread: { [uid]: number }

conversations/{conversationId}/messages/{messageId}
  senderId, receiverId, type ("text" | "image"), text | imageURL, createdAt
```

## Known limitations

- **Presence** is best-effort: `isOnline`/`lastSeen` update on login, logout, and tab
  visibility changes, but a crashed tab or lost connection can leave a user shown as
  "Online" until they next open the app. A production app would use Realtime Database's
  `onDisconnect()` for this.
- **Old images aren't deleted from Cloudinary** when a profile photo is replaced, since
  deleting requires the API Secret, which must never live in frontend code. Deletion
  would need a small server endpoint (e.g. a Cloudinary-signed request from a backend).
- User search fetches the full `users` collection (capped at 50) rather than server-side
  text search — fine at this scale, but wouldn't scale to a large user base.

## Important

Never put Firebase Admin SDK / service-account credentials, or the Cloudinary API Secret,
in any frontend file.
