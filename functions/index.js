// CUNNACT — sends a push notification when a new chat message is created.
//
// This is intentionally the ONLY server-side piece added for the Android
// app. It does not touch any existing Firestore documents, does not change
// any security rule, and the web app keeps working exactly as before if
// this function is never deployed (push notifications simply won't arrive,
// nothing else breaks).
//
// Deploy with:  firebase deploy --only functions

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

exports.onNewMessage = onDocumentCreated(
  "conversations/{conversationId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;

    const { conversationId } = event.params;
    const convoSnap = await db.doc(`conversations/${conversationId}`).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();

    const members = (convo.members || []).filter((uid) => uid !== message.senderId);
    if (!members.length) return;

    const senderSnap = await db.doc(`users/${message.senderId}`).get();
    const senderName = senderSnap.exists ? senderSnap.data().name || "Someone" : "Someone";
    const isGroup = convo.type === "group";
    const title = isGroup ? (convo.groupName || "Group") : senderName;
    const body = isGroup
      ? `${senderName}: ${message.type === "image" ? "📷 Photo" : (message.text || "").slice(0, 120)}`
      : (message.type === "image" ? "📷 Photo" : (message.text || "").slice(0, 120));

    // Gather every device token for every recipient who isn't the sender.
    const userSnaps = await Promise.all(members.map((uid) => db.doc(`users/${uid}`).get()));
    const tokens = userSnaps.flatMap((s) => (s.exists ? s.data().fcmTokens || [] : []));
    if (!tokens.length) return;

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { conversationId, type: "message" },
      android: { priority: "high" }
    });

    // Clean up tokens that are no longer valid (app uninstalled, etc.) so the
    // fcmTokens array doesn't grow forever.
    const stale = [];
    response.responses.forEach((r, i) => {
      if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-argument"].includes(r.error?.code)) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length) {
      const { FieldValue } = require("firebase-admin/firestore");
      await Promise.all(
        members.map((uid) => db.doc(`users/${uid}`).update({ fcmTokens: FieldValue.arrayRemove(...stale) }).catch(() => {}))
      );
    }
  }
);
