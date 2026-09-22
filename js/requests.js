// First-contact request flow.
import {
  db, doc, getDoc, setDoc, updateDoc, collection, query, where,
  limit, onSnapshot, serverTimestamp
} from "./firebase.js";
import { playNotification, playSuccess } from "./sound.js";
import { showToast } from "./toast.js";

let requestsListener = null;
let pendingRequests = [];

function requestIdFor(a, b) { return [a, b].sort().join("_"); }

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
    const requestRef = doc(db, "messageRequests", conversationId);
    const payload = {
      senderId: currentUser.uid,
      receiverId: recipientId,
      senderEmail: currentUser.email || "",
      senderName: currentUser.displayName || currentUser.email || "User",
      receiverEmail: recipientData?.email || "",
      receiverName: recipientData?.name || recipientData?.email || "User",
      status: "pending",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    try {
      // No pre-read: a first-time request document does not exist yet.
      await setDoc(requestRef, payload);
      showToast("Message request sent", "success");
      return true;
    } catch (writeError) {
      let snap;
      try { snap = await getDoc(requestRef); } catch { throw writeError; }
      if (!snap.exists()) throw writeError;
      const status = snap.data()?.status;
      if (status === "pending") {
        showToast("Request already sent", "info");
        return false;
      }
      if (status === "accepted") {
        showToast("You're already connected", "info");
        return { alreadyExists: true, conversationId };
      }
      if (status === "declined") {
        await updateDoc(requestRef, { status: "pending", updatedAt: serverTimestamp() });
        showToast("Message request sent again", "success");
        return true;
      }
      throw writeError;
    }
  } catch (error) {
    console.error("Error sending request:", error);
    if (error?.code === "permission-denied") {
      showToast("Request couldn't be sent. The user may have blocked this account.", "error");
    } else if (error?.code === "failed-precondition") {
      showToast("Firebase needs an index. Open the browser console for the index link.", "error");
    } else {
      showToast("Failed to send request. Check your connection and try again.", "error");
    }
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
    await updateDoc(doc(db, "messageRequests", requestId), {
      status: "accepted",
      updatedAt: serverTimestamp()
    });
    await setDoc(doc(db, "conversations", conversationId), {
      members: [request.senderId, request.receiverId],
      createdAt: serverTimestamp(),
      unread: { [request.senderId]: 0, [request.receiverId]: 0 },
      lastMessage: "",
      lastMessageType: "text",
      lastMessageSenderId: "",
      lastMessageTime: serverTimestamp()
    });
    playSuccess();
    showToast("You're connected! 🎉", "success");
    return conversationId;
  } catch (error) {
    console.error("Error accepting request:", error);
    showToast(error?.code === "permission-denied" ? "Could not accept. Check the latest Firestore rules." : "Failed to accept request", "error");
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

export function getPendingRequestsCount() { return pendingRequests.length; }
