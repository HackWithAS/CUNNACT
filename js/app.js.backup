import {
  auth, db, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, increment
} from "./firebase.js";
import { uploadImageToCloudinary, validateImageFile, UploadError, MESSAGES as UPLOAD_MESSAGES } from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { $, escapeHtml, formatTime, formatWhen, formatLastSeen, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { normalizeSearch, matchesSearch } from "./users.js";

let currentUser = null;
let activeUser = null;
let activeConversationId = null;

let unsubscribeMessages = null;
let unsubscribeConversations = null;
const userListeners = new Map();   // uid -> { unsub, data }
let conversations = [];            // latest conversation docs, newest first
let pendingImageFile = null;
let pendingImageUrl = null;
let uploadController = null;

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

  listenConversations();
});

document.addEventListener("visibilitychange", () => {
  if (!currentUser) return;
  const isOnline = document.visibilityState === "visible";
  updateDoc(doc(db, "users", currentUser.uid), { isOnline, lastSeen: serverTimestamp() }).catch(() => {});
});
window.addEventListener("pagehide", () => {
  if (!currentUser) return;
  updateDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }).catch(() => {});
});

$("logoutBtn").addEventListener("click", async () => {
  if (currentUser) await setDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }, { merge: true });
  await signOut(auth);
});

$("profileBtn").addEventListener("click", () => location.href = "profile.html");
$("backBtn").addEventListener("click", () => $("app").classList.remove("chat-open"));

/* ===================== Search ===================== */

$("userSearch").addEventListener("input", debounce((e) => loadSearch(normalizeSearch(e.target.value)), 220));

async function loadSearch(term) {
  const box = $("searchResults");
  if (!term) { box.innerHTML = ""; return; }
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
  if (!matches.length) { box.innerHTML = `<div class="empty-state">No people found for “${escapeHtml(term)}”.</div>`; return; }

  box.innerHTML = matches.map((u) => `
    <div class="row-item search-user" data-uid="${u.uid}" role="option" tabindex="0">
      ${avatarHtml(u, { dot: false })}
      <div class="meta">
        <div class="top-line"><strong>${escapeHtml(u.name || u.email)}</strong></div>
        <div class="preview-line"><span class="bio">${escapeHtml(u.bio || u.email || "")}</span></div>
      </div>
    </div>`).join("");

  box.querySelectorAll(".search-user").forEach((el, i) => {
    paintAvatar(el.querySelector(".avatar"), { photoURL: matches[i].photoURL, name: matches[i].name, email: matches[i].email });
    const open = () => { $("userSearch").value = ""; box.innerHTML = ""; openChat(el.dataset.uid); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
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
    box.innerHTML = `<div class="empty-state">No conversations yet. Search for someone to start chatting.</div>`;
    return;
  }
  // If a conversation's own doc changes while it's the one open on screen (not just a brand
  // new message — e.g. the other person's client updates lastMessage/unread as a separate
  // write), make sure it doesn't sit with a stale unread badge until the user reopens it.
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
    const open = () => openChat(uid);
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
  activeConversationId = buildConversationId(currentUser.uid, uid);
  ensureUserListener(uid);

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
  const messagesRef = collection(db, "conversations", activeConversationId, "messages");
  const q = query(messagesRef, orderBy("createdAt"), limit(200));
  unsubscribeMessages = onSnapshot(q, (snap) => {
    const box = $("messages");
    box.innerHTML = "";
    snap.docs.forEach((d) => renderMessage({ id: d.id, ...d.data() }));
    box.scrollTop = box.scrollHeight;
    if (document.visibilityState === "visible") markRead(activeConversationId);
  }, () => {
    $("messages").innerHTML = `<div class="empty-state">Messages could not be loaded. Check your Firebase rules.</div>`;
  });
}

function renderMessage(message) {
  const el = document.createElement("div");
  const outgoing = message.senderId === currentUser.uid;
  const time = message.createdAt?.toDate ? formatTime(message.createdAt.toDate()) : "";

  if (message.type === "image" && message.imageURL) {
    el.className = `message image-message ${outgoing ? "outgoing" : ""}`;
    el.innerHTML = `<img src="${escapeHtml(message.imageURL)}" alt="Shared image" loading="lazy"><small>${time}</small>`;
    el.querySelector("img").addEventListener("click", () => openLightbox(message.imageURL));
  } else {
    el.className = `message ${outgoing ? "outgoing" : ""}`;
    el.innerHTML = `<p>${escapeHtml(message.text || "")}</p><small>${time}${outgoing ? " ✓" : ""}</small>`;
  }
  $("messages").appendChild(el);
}

/* ===================== Sending text ===================== */

$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeUser) return;
  const text = $("messageInput").value.trim();
  if (!text) return;
  $("messageInput").value = "";
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
    createdAt: serverTimestamp()
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

$("attachBtn").addEventListener("click", () => $("fileInput").click());

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
  uploadController?.abort();
  clearImagePreview();
  $("messageInput").disabled = !activeUser;
});

$("imagePreviewSend").addEventListener("click", async () => {
  if (!pendingImageFile || !activeUser) return;
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
