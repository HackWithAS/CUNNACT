# CUNNACT

A modern real-time one-to-one messaging web application built with HTML, CSS, JavaScript and Firebase.

## Stack

- HTML5
- CSS3
- Vanilla JavaScript
- Firebase Authentication
- Cloud Firestore
- Firebase Storage

## Firebase setup

1. Create a project at Firebase Console.
2. Add a Web App.
3. Enable Authentication -> Sign-in method -> Email/Password.
4. Create a Firestore database.
5. Create Firebase Storage.
6. Copy the Web App configuration into `js/firebase-config.js`.
7. Deploy rules:

```bash
firebase login
firebase use YOUR_PROJECT_ID
firebase deploy --only firestore:rules,storage
```

8. Run the site through a local web server (for example VS Code Live Server).
9. Deploy hosting when ready:

```bash
firebase deploy --only hosting
```

## Firestore structure

```text
users/{uid}
conversations/{conversationId}
conversations/{conversationId}/messages/{messageId}
```

## Important

Never put Firebase Admin SDK/service-account credentials in frontend files.

The initial UI and core text-chat flow are intentionally simple so the interface can be redesigned independently.
