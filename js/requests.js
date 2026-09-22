// First-contact message request flow. A deterministic request id lets Firestore
// security rules verify that a 1:1 conversation was created only after acceptance.

import {
  db, doc, getDoc, setDoc, updateDoc, collection, query, where,
  limit, onSnapshot, serverTimestamp
} from "./firebase.js";
import { playNotification, playSuccess } from "./sound.js";
import { showToast } from "./toast.js";

let requestsListener = null;
let pendingRequests = [];

function requestIdFor(a, b) {
  return [a, b].sort().join("_");
}

export function listenMessageRequests(currentUser, callback) {
  requestsListener?.();

  const q = query(
    collection(db, "messageRequests"),
    where("receiverId", "==", currentUser.uid),
    limit(50)
  );

  requestsListener = onSnapshot(q, (snap) => {
    const next = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((request) => request.status === "pending")
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    if (next.length > pendingRequests.length) playNotification();
    pendingRequests = next;
    callback(next);
  }, (error) => {
    console.error("Message request listener failed:", error);
    pendingRequests = [];
    callback([]);
  });
}

export async function sendMessageRequest(currentUser, recipientId, recipientData) {
  try {
    if (!currentUser?.uid || !recipientId || currentUser.uid === recipientId) {
      showToast("You can't message yourself.", "error");
      return false;
    }

    const conversationId = requestIdFor(currentUser.uid, recipientId);
    const conversationSnap = await getDoc(doc(db, "conversations", conversationId));
    if (conversationSnap.exists()) {
      showToast("Conversation already exists", "info");
      return { alreadyExists: true, conversationId };
    }

    const requestId = requestIdFor(currentUser.uid, recipientId);
    const requestRef = doc(db, "messageRequests", requestId);
    const requestSnap = await getDoc(requestRef);

    if (requestSnap.exists()) {
      const status = requestSnap.data().status;
      if (status === "pending") {
        showToast("Request already sent", "info");
        return false;
      }
      if (status === "accepted") {
        showToast("Request was already accepted. Please refresh.", "info");
        return false;
      }

      // Re-request is allowed after a previous decline.
      await updateDoc(requestRef, {
        status: "pending",
        updatedAt: serverTimestamp()
      });
      showToast("Message request sent again", "success");
      return true;
    }

    await setDoc(requestRef, {
      senderId: currentUser.uid,
      receiverId: recipientId,
      senderEmail: currentUser.email || "",
      senderName: currentUser.displayName || currentUser.email || "User",
      receiverEmail: recipientData.email || "",
      receiverName: recipientData.name || recipientData.email || "User",
      status: "pending",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    showToast("Message request sent", "success");
    return true;
  } catch (error) {
    console.error("Error sending request:", error);
    showToast("Failed to send request", "error");
    return false;
  }
}

export async function acceptMessageRequest(requestId, request, currentUser) {
  try {
    if (!request || request.receiverId !== currentUser.uid || request.status !== "pending") {
      showToast("This request is no longer available.", "error");
      return null;
    }

    const conversationId = requestIdFor(request.senderId, request.receiverId);
    const existingConversation = await getDoc(doc(db, "conversations", conversationId));

    await updateDoc(doc(db, "messageRequests", requestId), {
      status: "accepted",
      updatedAt: serverTimestamp()
    });

    if (!existingConversation.exists()) {
      await setDoc(doc(db, "conversations", conversationId), {
        members: [request.senderId, request.receiverId],
        createdAt: serverTimestamp(),
        lastMessageTime: null,
        lastMessage: "",
        lastMessageType: "text",
        lastMessageSenderId: "",
        unread: {
          [request.senderId]: 0,
          [request.receiverId]: 0
        }
      });
    }

    playSuccess();
    showToast("You're connected! 🎉", "success");
    return conversationId;
  } catch (error) {
    console.error("Error accepting request:", error);
    showToast("Failed to accept request", "error");
    return null;
  }
}

export async function declineMessageRequest(requestId) {
  try {
    await updateDoc(doc(db, "messageRequests", requestId), {
      status: "declined",
      updatedAt: serverTimestamp()
    });
    showToast("Request declined", "info");
    return true;
  } catch (error) {
    console.error("Error declining request:", error);
    showToast("Failed to decline request", "error");
    return false;
  }
}

export function stopListeningRequests() {
  requestsListener?.();
  requestsListener = null;
  pendingRequests = [];
}

export function getPendingRequestsCount() {
  return pendingRequests.length;
}
