import {
  auth, db, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, increment
} from "./firebase.js";
import { uploadImageToCloudinary, validateImageFile, UploadError, MESSAGES as UPLOAD_MESSAGES } from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { $, escapeHtml, formatTime, formatWhen, formatLastSeen, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { normalizeSearch, matchesSearch, isSearchValid, getSearchMessage, SEARCH_MIN_LENGTH } from "./users.js";
import { listenMessageRequests, sendMessageRequest, acceptMessageRequest, declineMessageRequest, getPendingRequestsCount } from "./requests.js";
import { playClick, playSend, playReceive, isSoundEnabled, toggleSound } from "./sound.js";
import { shouldExpireMessage, cleanupExpiredMessages, startPeriodicCleanup } from "./retention.js";

let currentUser = null;
let activeUser = null;
let activeConversationId = null;

let unsubscribeMessages = null;
let unsubscribeConversations = null;
const userListeners = new Map();
let conversations = [];
let pendingImageFile = null;
let pendingImageUrl = null;
let uploadController = null;
let cleanupInterval = null;
let currentMessages = [];

/* ===================== Auth bootstrap ===================== */

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  currentUser = user;

  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() : {};
  $("currentUserName").textContent = data.name || user.displayName || user.email;
  $("currentUserStatus").textContent = "Online";
  paintAvatar($("currentUserAvatar"), { photoURL: data.photoURL, name: data.name || user.displayName, email: user.email, preset: "avatarSm" });

  await setDoc(doc(db, "users", user.uid), { isOnline: true, lastSeen: serverTimestamp() }, { merge: true });

  // Update sound toggle UI
  updateSoundToggle();

  // Listen to message requests
  listenMessageRequests(currentUser, (requests) => {
    updateRequestsBadge(requests.length);
    renderMessageRequests(requests);
  });

  listenConversations();
});

document.addEventListener("visibilitychange", () => {
  if (!currentUser) return;
  const isOnline = document.visibilityState === "visible";
  updateDoc(doc(db, "users", currentUser.uid), { isOnline, lastSeen: serverTimestamp() }).catch(() => {});
  
  // Cleanup expired messages when app becomes visible
  if (isOnline && activeConversationId && currentMessages.length > 0) {
    cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, deleteDoc);
  }
});

window.addEventListener("pagehide", () => {
  if (!currentUser) return;
  updateDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }).catch(() => {});
});

$("logoutBtn").addEventListener("click", async () => {
  playClick();
  if (currentUser) await setDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }, { merge: true });
  await signOut(auth);
});

$("profileBtn").addEventListener("click", () => { playClick(); location.href = "profile.html"; });
$("backBtn").addEventListener("click", () => { playClick(); $("app").classList.remove("chat-open"); });

// Sound toggle button
$("soundToggle")?.addEventListener("click", () => {
  const enabled = toggleSound();
  if (enabled) playClick();
  updateSoundToggle();
});

function updateSoundToggle() {
  const btn = $("soundToggle");
  if (!btn) return;
  const enabled = isSoundEnabled();
  btn.textContent = enabled ? "🔊" : "🔇";
  btn.setAttribute("aria-label", enabled ? "Sound on" : "Sound off");
  btn.title = enabled ? "Sound on" : "Sound off";
}

/* ===================== Message Requests ===================== */

function updateRequestsBadge(count) {
  const badge = $("requestsBadge");
  if (!badge) return;
  
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : count;
    badge.hidden = false;
    badge.classList.add("unread-badge");
  } else {
    badge.hidden = true;
  }
}

function renderMessageRequests(requests) {
  const container = $("requestsList");
  if (!container) return;
  
  if (requests.length === 0) {
    container.innerHTML = `<div class="empty-state">No new requests.</div>`;
    return;
  }
  
  container.innerHTML = requests.map(req => `
    <div class="request-item" data-request-id="${req.id}">
      ${avatarHtml({ name: req.senderName, email: req.senderEmail }, { dot: false })}
      <div class="meta">
        <strong>${escapeHtml(req.senderName)}</strong>
        <span class="email">${escapeHtml(req.senderEmail)}</span>
        <span class="subtitle">Wants to start a conversation</span>
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-primary accept-request" data-request-id="${req.id}">Accept</button>
        <button class="btn btn-sm btn-ghost decline-request" data-request-id="${req.id}">Decline</button>
      </div>
    </div>
  `).join("");
  
  // Paint avatars
  container.querySelectorAll(".request-item").forEach((el, i) => {
    paintAvatar(el.querySelector(".avatar"), {
      photoURL: "",
      name: requests[i].senderName,
      email: requests[i].senderEmail
    });
  });
  
  // Attach event listeners
  container.querySelectorAll(".accept-request").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      playClick();
      const requestId = e.target.dataset.requestId;
      const request = requests.find(r => r.id === requestId);
      if (!request) return;
      
      e.target.disabled = true;
      e.target.textContent = "Accepting...";
      
      const conversationId = await acceptMessageRequest(requestId, request, currentUser);
      if (conversationId) {
        openChatById(conversationId);
      }
    });
  });
  
  container.querySelectorAll(".decline-request").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      playClick();
      const requestId = e.target.dataset.requestId;
      e.target.disabled = true;
      e.target.textContent = "Declining...";
      await declineMessageRequest(requestId);
    });
  });
}

/* ===================== Search ===================== */

$("userSearch").addEventListener("input", debounce((e) => {
  const term = normalizeSearch(e.target.value);
  loadSearch(term);
}, 220));

async function loadSearch(term) {
  const box = $("searchResults");
  
  if (!term) {
    box.innerHTML = "";
    return;
  }
  
  // Check minimum length
  if (!isSearchValid(term)) {
    const message = getSearchMessage(term);
    box.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    return;
  }
  
  box.innerHTML = `<div class="empty-state">Searching…</div>`;
  
  let users;
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("name"), limit(50)));
    users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch {
    box.innerHTML = `<div class="empty-state">Search is unavailable right now.</div>`;
    return;
  }
  
  const matches = users.filter((u) => matchesSearch(u, term, currentUser?.uid));
  
  if (!matches.length) {
    box.innerHTML = `<div class="empty-state">No people found for "${escapeHtml(term)}".</div>`;
    return;
  }

  box.innerHTML = matches.map((u) => `
    <div class="row-item search-user" data-uid="${u.uid}" role="option" tabindex="0">
      ${avatarHtml(u, { dot: false })}
      <div class="meta">
        <div class="top-line"><strong>${escapeHtml(u.name || u.email)}</strong></div>
        <div class="preview-line"><span class="bio">${escapeHtml(u.email || "")}</span></div>
      </div>
      <button class="btn btn-sm btn-primary send-request" data-uid="${u.uid}">Send Request</button>
    </div>`).join("");

  box.querySelectorAll(".search-user").forEach((el, i) => {
    paintAvatar(el.querySelector(".avatar"), { photoURL: matches[i].photoURL, name: matches[i].name, email: matches[i].email });
    
    const btn = el.querySelector(".send-request");
    btn.addEventListener("click", async (e) => {
      playClick();
      e.stopPropagation();
      const uid = e.target.dataset.uid;
      const user = matches.find(u => u.uid === uid);
      if (!user) return;
      
      btn.disabled = true;
      btn.textContent = "Sending...";
      
      const result = await sendMessageRequest(currentUser, uid, user);
      
      if (result && result.alreadyExists) {
        $("userSearch").value = "";
        box.innerHTML = "";
        openChatById(result.conversationId);
      } else if (result) {
        btn.textContent = "Sent ✓";
        setTimeout(() => {
          $("userSearch").value = "";
          box.innerHTML = "";
        }, 1500);
      } else {
        btn.disabled = false;
        btn.textContent = "Send Request";
      }
    });
  });
}

/* ===================== Conversation list ===================== */

function listenConversations() {
  const q = query(
    collection(db, "conversations"),
    where("members", "array-contains", currentUser.uid),
    orderBy("lastMessageTime", "desc"),
    limit(50)
  );
  
  unsubscribeConversations?.();
  unsubscribeConversations = onSnapshot(q, (snap) => {
    conversations = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    conversations.forEach((c) => ensureUserListener(otherUid(c)));
    renderChatList();
  }, () => {
    $("chatList").innerHTML = `<div class="empty-state">Conversations could not be loaded. Check your Firebase rules.</div>`;
  });
}

function otherUid(conversation) {
  return conversation.members.find((m) => m !== currentUser.uid);
}

function ensureUserListener(uid) {
  if (!uid || userListeners.has(uid)) return;
  const entry = { unsub: null, data: null };
  entry.unsub = onSnapshot(doc(db, "users", uid), (snap) => {
    entry.data = snap.exists() ? { uid, ...snap.data() } : { uid };
    renderChatList();
    if (activeUser?.uid === uid) refreshChatHeader();
  });
  userListeners.set(uid, entry);
}

function renderChatList() {
  const box = $("chatList");
  if (!conversations.length) {
    box.innerHTML = `<div class="empty-state">
      <p>Your inbox is quiet.</p>
      <p>Find someone and start a conversation.</p>
    </div>`;
    return;
  }
  
  const active = conversations.find((c) => c.id === activeConversationId);
  if (active && (active.unread?.[currentUser.uid] || 0) > 0 && document.visibilityState === "visible") {
    markRead(activeConversationId);
  }

  box.innerHTML = conversations.map((c) => {
    const uid = otherUid(c);
    const user = userListeners.get(uid)?.data || { uid };
    const unread = c.unread?.[currentUser.uid] || 0;
    const when = c.lastMessageTime?.toDate ? formatWhen(c.lastMessageTime.toDate()) : "";
    const preview = previewText(
      c.lastMessage ? { type: c.lastMessageType, text: c.lastMessage } : null,
      { isMine: c.lastMessageSenderId === currentUser.uid }
    );
    
    return `
      <div class="row-item chat-item ${activeConversationId === c.id ? "active" : ""}" data-uid="${uid}" role="option" tabindex="0">
        ${avatarHtml(user)}
        <div class="meta">
          <div class="top-line"><strong>${escapeHtml(user.name || user.email || "…")}</strong><span class="time">${when}</span></div>
          <div class="preview-line">
            <span class="text">${escapeHtml(preview)}</span>
            ${unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
          </div>
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll(".chat-item").forEach((el, i) => {
    const uid = otherUid(conversations[i]);
    const user = userListeners.get(uid)?.data || { uid };
    paintAvatar(el.querySelector(".avatar"), { photoURL: user.photoURL, name: user.name, email: user.email });
    const dot = el.querySelector(".status-dot");
    if (dot) dot.classList.toggle("online", !!user.isOnline);
    
    const open = () => { playClick(); openChat(uid); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
}

/* ===================== Active conversation ===================== */

function refreshChatHeader() {
  if (!activeUser) return;
  const live = userListeners.get(activeUser.uid)?.data;
  if (live) activeUser = { ...activeUser, ...live };
  
  $("chatName").textContent = activeUser.name || activeUser.email;
  $("chatStatus").textContent = activeUser.isOnline
    ? "Online"
    : formatLastSeen(activeUser.lastSeen?.toDate ? activeUser.lastSeen.toDate() : null);
  $("chatStatusDot").classList.toggle("online", !!activeUser.isOnline);
  paintAvatar($("chatAvatar"), { photoURL: activeUser.photoURL, name: activeUser.name, email: activeUser.email });
}

async function openChat(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return;
  activeUser = { uid, ...snap.data() };
  openChatById(buildConversationId(currentUser.uid, uid));
}

async function openChatById(conversationId) {
  activeConversationId = conversationId;
  
  // Extract UIDs from conversation ID
  const [uid1, uid2] = conversationId.split("_");
  const otherUid = uid1 === currentUser.uid ? uid2 : uid1;
  
  const snap = await getDoc(doc(db, "users", otherUid));
  if (!snap.exists()) return;
  activeUser = { uid: otherUid, ...snap.data() };
  
  ensureUserListener(otherUid);
  refreshChatHeader();
  
  $("messageInput").disabled = false;
  $("attachBtn").disabled = false;
  $("messageForm").querySelector("button[type=submit]").disabled = false;
  $("app").classList.add("chat-open");
  
  clearImagePreview();
  renderChatList();
  listenMessages();
  markRead(activeConversationId);
}

function markRead(conversationId) {
  updateDoc(doc(db, "conversations", conversationId), { [`unread.${currentUser.uid}`]: 0 }).catch(() => {});
}

function listenMessages() {
  unsubscribeMessages?.();
  if (cleanupInterval) cleanupInterval();
  
  const messagesRef = collection(db, "conversations", activeConversationId, "messages");
  const q = query(messagesRef, orderBy("createdAt"), limit(200));
  
  unsubscribeMessages = onSnapshot(q, async (snap) => {
    const box = $("messages");
    box.innerHTML = "";
    
    currentMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    // Cleanup expired messages
    await cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, deleteDoc);
    
    // Render remaining messages
    currentMessages.forEach((msg) => {
      if (!shouldExpireMessage(msg, currentUser.uid)) {
        renderMessage(msg);
      }
    });
    
    box.scrollTop = box.scrollHeight;
    
    if (document.visibilityState === "visible") {
      markRead(activeConversationId);
    }
  }, () => {
    $("messages").innerHTML = `<div class="empty-state">Messages could not be loaded. Check your Firebase rules.</div>`;
  });
  
  // Start periodic cleanup
  cleanupInterval = startPeriodicCleanup(db, activeConversationId, () => currentMessages, currentUser.uid, deleteDoc);
}

function renderMessage(message) {
  const el = document.createElement("div");
  const outgoing = message.senderId === currentUser.uid;
  const time = message.createdAt?.toDate ? formatTime(message.createdAt.toDate()) : "";
  const saved = message.savedBy && message.savedBy.includes(currentUser.uid);

  if (message.type === "image" && message.imageURL) {
    el.className = `message image-message ${outgoing ? "outgoing" : ""} ${saved ? "saved" : ""}`;
    el.innerHTML = `
      <img src="${escapeHtml(message.imageURL)}" alt="Shared image" loading="lazy">
      <small>${time}</small>
      ${saved ? '<span class="bookmark-icon">🔖</span>' : ''}
    `;
    el.querySelector("img").addEventListener("click", () => openLightbox(message.imageURL));
  } else {
    el.className = `message ${outgoing ? "outgoing" : ""} ${saved ? "saved" : ""}`;
    el.innerHTML = `
      <p>${escapeHtml(message.text || "")}</p>
      <small>${time}${outgoing ? " ✓" : ""}</small>
      ${saved ? '<span class="bookmark-icon">🔖</span>' : ''}
    `;
  }
  
  // Add message actions on right-click or long-press
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMessageActions(el, message, outgoing);
  });
  
  el.addEventListener("touchstart", (e) => {
    let timer = setTimeout(() => {
      showMessageActions(el, message, outgoing);
    }, 500);
    
    el.addEventListener("touchend", () => clearTimeout(timer), { once: true });
    el.addEventListener("touchmove", () => clearTimeout(timer), { once: true });
  });
  
  $("messages").appendChild(el);
  
  // Play receive sound for new incoming messages
  if (!outgoing && !message._rendered) {
    playReceive();
    message._rendered = true;
  }
}

function showMessageActions(messageEl, message, isOutgoing) {
  // Remove any existing menu
  document.querySelectorAll(".message-action-menu").forEach(m => m.remove());
  
  const menu = document.createElement("div");
  menu.className = "message-action-menu";
  
  const saved = message.savedBy && message.savedBy.includes(currentUser.uid);
  
  menu.innerHTML = `
    <button class="menu-item save-msg">${saved ? "Unsave" : "Save"}</button>
    ${isOutgoing ? '<button class="menu-item delete-msg">Delete for everyone</button>' : ''}
    <button class="menu-item delete-for-me">Delete for me</button>
  `;
  
  document.body.appendChild(menu);
  
  const rect = messageEl.getBoundingClientRect();
  menu.style.top = `${rect.top - menu.offsetHeight - 5}px`;
  menu.style.left = `${rect.left}px`;
  
  menu.querySelector(".save-msg").addEventListener("click", async () => {
    playClick();
    await toggleSaveMessage(message.id, saved);
    menu.remove();
  });
  
  if (isOutgoing) {
    menu.querySelector(".delete-msg")?.addEventListener("click", async () => {
      playClick();
      await deleteMessageForEveryone(message.id);
      menu.remove();
    });
  }
  
  menu.querySelector(".delete-for-me").addEventListener("click", async () => {
    playClick();
    await deleteMessageForMe(message.id, messageEl);
    menu.remove();
  });
  
  // Close menu on outside click
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 100);
}

async function toggleSaveMessage(messageId, currentlySaved) {
  try {
    const msgRef = doc(db, "conversations", activeConversationId, "messages", messageId);
    
    if (currentlySaved) {
      // Unsave
      const snap = await getDoc(msgRef);
      const savedBy = snap.data()?.savedBy || [];
      const updated = savedBy.filter(uid => uid !== currentUser.uid);
      await updateDoc(msgRef, { savedBy: updated });
      showToast("Message unsaved", "info");
    } else {
      // Save
      const snap = await getDoc(msgRef);
      const savedBy = snap.data()?.savedBy || [];
      if (!savedBy.includes(currentUser.uid)) {
        savedBy.push(currentUser.uid);
      }
      await updateDoc(msgRef, { savedBy, savedAt: serverTimestamp() });
      showToast("Message saved 🔖", "success");
    }
  } catch (error) {
    console.error("Error toggling save:", error);
    showToast("Failed to update message", "error");
  }
}

async function deleteMessageForEveryone(messageId) {
  if (!confirm("Delete this message for everyone?")) return;
  
  try {
    await deleteDoc(doc(db, "conversations", activeConversationId, "messages", messageId));
    showToast("Message deleted", "info");
  } catch (error) {
    console.error("Error deleting message:", error);
    showToast("Failed to delete message", "error");
  }
}

async function deleteMessageForMe(messageId, messageEl) {
  try {
    messageEl.classList.add("deleting");
    setTimeout(async () => {
      await deleteDoc(doc(db, "conversations", activeConversationId, "messages", messageId));
    }, 300);
  } catch (error) {
    console.error("Error deleting message:", error);
    messageEl.classList.remove("deleting");
    showToast("Failed to delete message", "error");
  }
}

/* ===================== Sending text ===================== */

$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeUser) return;
  
  const text = $("messageInput").value.trim();
  if (!text) return;
  
  $("messageInput").value = "";
  playSend();
  await sendMessage({ type: "text", text });
});

async function sendMessage({ type, text, imageURL }) {
  const cid = activeConversationId;
  const otherId = activeUser.uid;
  
  await setDoc(doc(db, "conversations", cid), { members: [currentUser.uid, otherId] }, { merge: true });
  
  await addDoc(collection(db, "conversations", cid, "messages"), {
    senderId: currentUser.uid,
    receiverId: otherId,
    type,
    ...(type === "image" ? { imageURL } : { text }),
    createdAt: serverTimestamp(),
    savedBy: []
  });
  
  await updateDoc(doc(db, "conversations", cid), {
    lastMessage: type === "image" ? "" : text,
    lastMessageType: type,
    lastMessageSenderId: currentUser.uid,
    lastMessageTime: serverTimestamp(),
    [`unread.${otherId}`]: increment(1)
  });
}

/* ===================== Sending images ===================== */

$("attachBtn").addEventListener("click", () => { playClick(); $("fileInput").click(); });

$("fileInput").addEventListener("change", async () => {
  const file = $("fileInput").files[0];
  $("fileInput").value = "";
  if (!file) return;

  try {
    await validateImageFile(file);
  } catch (error) {
    showToast(error instanceof UploadError ? error.userMessage : UPLOAD_MESSAGES.invalid, "error");
    return;
  }

  pendingImageFile = file;
  pendingImageUrl = URL.createObjectURL(file);
  $("imagePreviewThumb").src = pendingImageUrl;
  $("imagePreviewStatus").textContent = "Ready to send";
  $("imagePreviewProgress").style.width = "0%";
  $("imagePreviewBar").classList.remove("uploading");
  $("imagePreviewBar").hidden = false;
  $("messageInput").disabled = true;
});

$("imagePreviewCancel").addEventListener("click", () => {
  playClick();
  uploadController?.abort();
  clearImagePreview();
  $("messageInput").disabled = !activeUser;
});

$("imagePreviewSend").addEventListener("click", async () => {
  if (!pendingImageFile || !activeUser) return;
  
  playClick();
  const file = pendingImageFile;
  const bar = $("imagePreviewBar");
  bar.classList.add("uploading");
  $("imagePreviewSend").disabled = true;
  $("imagePreviewStatus").textContent = "Uploading…";
  uploadController = new AbortController();

  try {
    const url = await uploadImageToCloudinary(file, {
      signal: uploadController.signal,
      onProgress: (p) => { $("imagePreviewProgress").style.width = `${Math.round(p * 100)}%`; }
    });
    await sendMessage({ type: "image", imageURL: url });
    playSend();
    showToast("Image sent", "success");
    clearImagePreview();
  } catch (error) {
    if (error?.kind === "aborted") return;
    const message = error instanceof UploadError ? error.userMessage : UPLOAD_MESSAGES.failed;
    $("imagePreviewStatus").textContent = message;
    bar.classList.remove("uploading");
    $("imagePreviewSend").disabled = false;
  }
});

function clearImagePreview() {
  if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  pendingImageFile = null;
  pendingImageUrl = null;
  $("imagePreviewBar").hidden = true;
  $("imagePreviewBar").classList.remove("uploading");
  $("imagePreviewSend").disabled = false;
  $("imagePreviewThumb").src = "";
  if (activeUser) $("messageInput").disabled = false;
}
