// Message request system for CUNNACT
// Handles sending, accepting, and declining conversation requests

import { auth, db, doc, getDoc, setDoc, updateDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp } from "./firebase.js";
import { playNotification, playSuccess } from "./sound.js";
import { showToast } from "./toast.js";

let requestsListener = null;
let pendingRequests = [];

export function listenMessageRequests(currentUser, callback) {
  if (requestsListener) requestsListener();
  
  const q = query(
    collection(db, "messageRequests"),
    where("receiverId", "==", currentUser.uid),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc")
  );
  
  requestsListener = onSnapshot(q, (snap) => {
    const oldCount = pendingRequests.length;
    pendingRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    // Play notification sound for new requests
    if (pendingRequests.length > oldCount) {
      playNotification();
    }
    
    callback(pendingRequests);
  });
}

export async function sendMessageRequest(currentUser, recipientId, recipientData) {
  try {
    // Check if request already exists
    const requestId = [currentUser.uid, recipientId].sort().join("_");
    const requestSnap = await getDoc(doc(db, "messageRequests", requestId));
    
    if (requestSnap.exists()) {
      const status = requestSnap.data().status;
      if (status === "pending") {
        showToast("Request already sent", "info");
        return false;
      } else if (status === "declined") {
        showToast("This user declined your previous request", "error");
        return false;
      }
    }
    
    // Check if conversation already exists
    const conversationId = [currentUser.uid, recipientId].sort().join("_");
    const convSnap = await getDoc(doc(db, "conversations", conversationId));
    
    if (convSnap.exists()) {
      showToast("Conversation already exists", "info");
      return { alreadyExists: true, conversationId };
    }
    
    // Create new request
    await setDoc(doc(db, "messageRequests", requestId), {
      senderId: currentUser.uid,
      receiverId: recipientId,
      senderEmail: currentUser.email,
      senderName: currentUser.displayName || currentUser.email,
      receiverEmail: recipientData.email,
      receiverName: recipientData.name || recipientData.email,
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
    // Update request status
    await updateDoc(doc(db, "messageRequests", requestId), {
      status: "accepted",
      updatedAt: serverTimestamp()
    });
    
    // Create conversation
    const conversationId = [request.senderId, request.receiverId].sort().join("_");
    await setDoc(doc(db, "conversations", conversationId), {
      members: [request.senderId, request.receiverId],
      createdAt: serverTimestamp(),
      lastMessageTime: serverTimestamp(),
      lastMessage: "",
      lastMessageType: "text",
      lastMessageSenderId: "",
      unread: {
        [request.senderId]: 0,
        [request.receiverId]: 0
      }
    });
    
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
  if (requestsListener) {
    requestsListener();
    requestsListener = null;
  }
}

export function getPendingRequestsCount() {
  return pendingRequests.length;
}
