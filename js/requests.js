import {
  db, doc, getDoc, setDoc, updateDoc, collection, query, where,
  limit, onSnapshot, serverTimestamp, deleteDoc
} from "./firebase.js";
import { playNotification, playSuccess } from "./sound.js";
import { showToast } from "./toast.js";

let requestsListener = null;
let outgoingRequestsListener = null;
let pendingRequests = [];
let pendingOutgoingRequests = [];
const requestIdFor = (a, b) => [a, b].sort().join("_");

export function listenMessageRequests(currentUser, callback, outgoingCallback = () => {}) {
  requestsListener?.();
  outgoingRequestsListener?.();

  const incomingQ = query(collection(db, "messageRequests"), where("receiverId", "==", currentUser.uid), limit(50));
  requestsListener = onSnapshot(incomingQ, (snap) => {
    const next = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .filter(r => r.status === "pending")
      .sort((a,b)=>(b.createdAt?.toMillis?.()??0)-(a.createdAt?.toMillis?.()??0));
    if (next.length > pendingRequests.length) playNotification();
    pendingRequests = next;
    callback(next);
  }, (error) => {
    console.error("Incoming message request listener failed:", error);
    pendingRequests = [];
    callback([]);
  });

  const outgoingQ = query(collection(db, "messageRequests"), where("senderId", "==", currentUser.uid), limit(50));
  outgoingRequestsListener = onSnapshot(outgoingQ, (snap) => {
    pendingOutgoingRequests = snap.docs
      .map(d => ({ id:d.id, ...d.data() }))
      .filter(r => r.status === "pending");
    outgoingCallback(pendingOutgoingRequests);
  }, (error) => {
    console.error("Outgoing message request listener failed:", error);
    pendingOutgoingRequests = [];
    outgoingCallback([]);
  });
}

export function getOutgoingPendingRequest(recipientId) {
  return pendingOutgoingRequests.find(r => r.receiverId === recipientId && r.status === "pending") || null;
}

export async function sendMessageRequest(currentUser, recipientId, recipientData = {}) {
  try {
    if (!currentUser?.uid || !recipientId || currentUser.uid === recipientId) {
      showToast("You can't message yourself.", "error"); return false;
    }

    const conversationId = requestIdFor(currentUser.uid, recipientId);
    const requestRef = doc(db, "messageRequests", conversationId);

    // Read first so an existing request is never accidentally overwritten with
    // a full create payload. Firestore treats setDoc(..., merge:false) on an
    // existing document as an update, which is rejected by our restricted rules.
    let existing = null;
    try {
      const snap = await getDoc(requestRef);
      if (snap.exists()) existing = snap.data() || {};
    } catch (readError) {
      // A missing/legacy request should still be creatable. Re-throw only for
      // a real permission failure on an existing record.
      if (readError?.code === "permission-denied") {
        console.warn("Unable to inspect existing request before create:", readError);
      }
    }

    if (existing) {
      const status = existing.status;
      if (status === "pending") {
        if (existing.senderId === recipientId && existing.receiverId === currentUser.uid) {
          showToast("This person already sent you a request. Open Message Requests to accept it.", "info");
          return { incomingPending:true };
        }
        if (existing.senderId === currentUser.uid && existing.receiverId === recipientId) {
          showToast("Request already sent", "info");
          return { pending:true, requestId:conversationId };
        }
      }
      if (status === "accepted") {
        showToast("You're already connected", "info");
        return { alreadyExists:true, conversationId };
      }
      if (status === "declined" && existing.senderId === currentUser.uid) {
        await updateDoc(requestRef, { status:"pending", updatedAt:serverTimestamp() });
        showToast("Message request sent again", "success");
        return { true:true, requestId:conversationId };
      }
    }

    const payload = {
      senderId: currentUser.uid,
      receiverId: recipientId,
      senderEmail: currentUser.email || "",
      senderName: currentUser.displayName || "User",
      senderUsername: currentUser.username || "",
      senderPhotoURL: currentUser.photoURL || "",
      receiverEmail: recipientData.email || "",
      receiverName: recipientData.name || recipientData.displayName || "User",
      receiverUsername: recipientData.username || "",
      status: "pending",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    await setDoc(requestRef, payload, { merge:false });
    showToast("Message request sent", "success");
    return true;
  } catch (error) {
    console.error("Error sending request:", error);
    const code = error?.code || "unknown";
    if (code === "permission-denied") {
      showToast("Firebase rejected this request. Check that neither account is blocked and the latest firestore.rules are deployed.", "error");
    } else if (code === "failed-precondition") {
      showToast("Firebase needs an index. Check the browser console for the index link.", "error");
    } else if (code === "unavailable" || code === "network-request-failed") {
      showToast("Could not reach Firebase. Check your internet connection and try again.", "error");
    } else {
      showToast("Failed to send request. Please try again.", "error");
    }
    return false;
  }
}

export async function cancelMessageRequest(requestId) {
  try {
    if (!requestId) return false;
    await deleteDoc(doc(db, "messageRequests", requestId));
    showToast("Request cancelled", "info");
    return true;
  } catch (error) {
    console.error("Error cancelling request:", error);
    if (error?.code === "permission-denied") {
      showToast("Firebase rejected the cancellation. Deploy the latest firestore.rules and try again.", "error");
    } else {
      showToast("Could not cancel the request. Please try again.", "error");
    }
    return false;
  }
}

export async function acceptMessageRequest(requestId, request, currentUser) {
  try {
    if (!request || request.receiverId !== currentUser.uid || request.status !== "pending") {
      showToast("This request is no longer available.", "error"); return null;
    }
    const conversationId = requestIdFor(request.senderId, request.receiverId);
    const requestRef = doc(db, "messageRequests", requestId);
    const conversationRef = doc(db, "conversations", conversationId);

    // Mark the request accepted first. Conversation creation is authorized by the
    // Firestore rules through the now-accepted request record. Do NOT call getDoc()
    // on a conversation that may not exist yet: its read rule requires membership,
    // and a non-existent document has no members field.
    await updateDoc(requestRef, { status:"accepted", updatedAt:serverTimestamp() });

    const conversationData = {
      members:[request.senderId, request.receiverId],
      createdAt:serverTimestamp(),
      unread:{ [request.senderId]:0, [request.receiverId]:0 },
      lastMessage:"",
      lastMessageType:"text",
      lastMessageSenderId:"",
      lastMessageId:"",
      lastMessageTime:serverTimestamp()
    };

    try {
      // Deterministic conversation IDs make create idempotent at the application level.
      // If another client created it first, treat that as success and continue.
      await setDoc(conversationRef, conversationData, { merge:false });
    } catch (createError) {
      if (createError?.code !== "already-exists") throw createError;
    }

    playSuccess();
    showToast("You're connected! 🎉", "success");
    return conversationId;
  } catch (error) {
    console.error("Error accepting request:", error);
    const code = error?.code || "";
    if (code === "permission-denied") {
      showToast("Firebase rejected the connection. Deploy the latest firestore.rules and try again.", "error");
    } else {
      showToast("Failed to create the chat. Please try again.", "error");
    }
    return null;
  }
}

export async function declineMessageRequest(requestId) {
  try { await updateDoc(doc(db,"messageRequests",requestId),{status:"declined",updatedAt:serverTimestamp()}); showToast("Request declined","info"); return true; }
  catch (error) { console.error(error); showToast("Failed to decline request","error"); return false; }
}
export function stopListeningRequests(){requestsListener?.();outgoingRequestsListener?.();requestsListener=null;outgoingRequestsListener=null;pendingRequests=[];pendingOutgoingRequests=[];}
export function getPendingRequestsCount(){return pendingRequests.length;}
