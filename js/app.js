import {
  auth, db, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection,
  query, where, orderBy, startAt, endAt, limit, onSnapshot,
  serverTimestamp, increment, writeBatch, arrayUnion, arrayRemove
} from "./firebase.js";
import { uploadImageToCloudinary, validateImageFile, UploadError, MESSAGES as UPLOAD_MESSAGES, isTrustedImageUrl, imageUrl } from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { formatTime, formatWhen, formatLastSeen, escapeHtml, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { normalizeSearch, isSearchValid, getSearchMessage } from "./users.js";
import { listenMessageRequests, sendMessageRequest, acceptMessageRequest, declineMessageRequest } from "./requests.js";
import { playClick, playSend, playReceive, playSave, playDelete, isSoundEnabled, toggleSound } from "./sound.js";
import { loadRetentionMode, getRetentionMode, shouldExpireMessage, cleanupExpiredMessages, startPeriodicCleanup, isSavedByUser, isDeletedForUser } from "./retention.js";

let currentUser = null;
let currentUserData = {};
let currentBlockedUsers = [];
let startupCleanupStarted = false;
let activeUser = null;
let activeConversationId = null;
let unsubscribeMessages = null;
let unsubscribeConversations = null;
let cleanupInterval = null;
let conversations = [];
let currentMessages = [];
const userListeners = new Map();
let chatSearchTerm = "";
let pendingImageFile = null;
let pendingImageUrl = null;
let uploadController = null;
let sendingMessage = false;
let messageListenerToken = 0;
let initialMessageSnapshot = true;

const $id = (id) => document.getElementById(id);
const icon = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="m7 7 10 10"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M7 10V7a5 5 0 0 1 9.7-1.6"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>'
};

/* ===================== Auth bootstrap ===================== */
onAuthStateChanged(auth, async (user) => {
  try {
    if (!user) {
      location.replace("login.html");
      return;
    }
    currentUser = user;
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    currentUserData = snap.exists() ? snap.data() : {};
    const name = currentUserData.name || user.displayName || user.email || "User";

    await setDoc(ref, {
      uid: user.uid,
      name,
      email: user.email || currentUserData.email || "",
      emailLower: String(user.email || currentUserData.email || "").toLowerCase(),
      photoURL: currentUserData.photoURL || user.photoURL || "",
      bio: currentUserData.bio || "",
      retentionMode: currentUserData.retentionMode || "24hours",
      isOnline: true,
      lastSeen: serverTimestamp()
    }, { merge: true });

    await loadRetentionMode(user.uid);
    await loadBlockedUsers();
    hydrateCurrentUserUI(name, user.email || currentUserData.email || "", currentUserData.photoURL || user.photoURL || "");
    updateSoundToggle();
    bindStaticControls();

    listenMessageRequests(currentUser, (requests) => {
      updateRequestsBadge(requests.length);
      renderMessageRequests(requests);
    });
    listenConversations();
    const gate = $id("authGate");
    if (gate) gate.hidden = true;
  } catch (error) {
    console.error("CUNNACT startup failed:", error);
    const gate = $id("authGate");
    if (gate) {
      gate.hidden = false;
      gate.innerHTML = `<div class="auth-gate-card"><strong>Couldn’t load CUNNACT</strong><span>${escapeHtml(error?.code || "Startup error")}</span><button id="retryBtn" class="btn btn-primary">Refresh</button></div>`;
      $id("retryBtn")?.addEventListener("click", () => location.reload());
    }
  }
});

function hydrateCurrentUserUI(name, email, photoURL) {
  $id("currentUserName").textContent = name;
  $id("currentUserEmail").textContent = email;
  $id("currentUserStatus").textContent = "Online";
  paintAvatar($id("currentUserAvatar"), { photoURL, name, email, preset: "avatarSm" });
  paintAvatar($id("menuUserAvatar"), { photoURL, name, email, preset: "avatarSm" });
  $id("menuUserName").textContent = name;
  $id("menuUserEmail").textContent = email;
}

/* ===================== Lifecycle ===================== */
document.addEventListener("visibilitychange", () => {
  if (!currentUser) return;
  const visible = document.visibilityState === "visible";
  updateDoc(doc(db, "users", currentUser.uid), { isOnline: visible, lastSeen: serverTimestamp() }).catch(() => {});
  if (visible && activeConversationId && currentMessages.length) {
    markIncomingMessagesRead().catch(() => {});
    cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc).catch(() => {});
  }
});
window.addEventListener("pagehide", () => {
  if (!currentUser) return;
  updateDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }).catch(() => {});
});

/* ===================== Static controls ===================== */
let staticBound = false;
function bindStaticControls() {
  if (staticBound) return;
  staticBound = true;
  updateSoundToggle();

  $id("logoutBtn")?.addEventListener("click", logout);
  $id("profileBtn")?.addEventListener("click", () => { playClick(); location.href = "profile.html"; });
  $id("accountMenuBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    playClick();
    toggleDropdown("accountMenu", "accountMenuBtn");
  });
  $id("soundToggle")?.addEventListener("click", () => {
    const enabled = toggleSound();
    updateSoundToggle();
    if (enabled) playClick();
  });
  $id("backBtn")?.addEventListener("click", () => {
    playClick();
    $id("app")?.classList.remove("chat-open");
  });
  $id("chatMoreBtn")?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!activeUser) return;
    playClick();
    renderChatMoreMenu();
    toggleDropdown("chatMoreMenu", "chatMoreBtn");
  });
  $id("newChatBtn")?.addEventListener("click", () => {
    playClick();
    openModal("newChatModal");
    setTimeout(() => $id("newChatSearch")?.focus(), 50);
  });
  $id("userSearch")?.addEventListener("input", debounce((event) => {
    chatSearchTerm = normalizeSearch(event.target.value);
    renderChatList();
  }, 120));
  $id("newChatSearch")?.addEventListener("input", debounce((event) => {
    loadNewChatSearch(normalizeSearch(event.target.value));
  }, 220));
  $id("requestsBtn")?.addEventListener("click", () => { playClick(); openModal("requestsModal"); });
  $id("savedBtn")?.addEventListener("click", async () => { playClick(); openModal("savedModal"); await renderSavedMessages(); });
  $id("messageForm")?.addEventListener("submit", handleMessageSubmit);
  $id("attachBtn")?.addEventListener("click", () => { playClick(); $id("fileInput")?.click(); });
  $id("fileInput")?.addEventListener("change", handleImageSelection);
  $id("imagePreviewCancel")?.addEventListener("click", cancelImagePreview);
  $id("imagePreviewSend")?.addEventListener("click", sendPendingImage);
  $id("messageInput")?.addEventListener("input", autoGrowComposer);

  document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => {
    playClick();
    const modal = button.closest(".modal");
    if (modal) closeModal(modal.id);
  }));
  document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal(modal.id);
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal:not([hidden])").forEach((modal) => closeModal(modal.id));
      document.querySelectorAll(".dropdown-menu:not([hidden])").forEach((menu) => menu.hidden = true);
      $id("accountMenuBtn")?.setAttribute("aria-expanded", "false");
      $id("chatMoreBtn")?.setAttribute("aria-expanded", "false");
      return;
    }
    const input = $id("messageInput");
    if (document.activeElement === input && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $id("messageForm")?.requestSubmit();
    }
  });
  document.addEventListener("click", (event) => {
    ["accountMenu", "chatMoreMenu"].forEach((id) => {
      const menu = $id(id);
      if (!menu || menu.hidden) return;
      const wrap = menu.parentElement;
      if (!wrap?.contains(event.target)) {
        menu.hidden = true;
        const btn = id === "accountMenu" ? $id("accountMenuBtn") : $id("chatMoreBtn");
        btn?.setAttribute("aria-expanded", "false");
      }
    });
    closeMessageActionMenus(event.target);
  });
}

async function logout() {
  playClick();
  try {
    if (currentUser) await setDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }, { merge: true });
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error);
    showToast("Could not log out. Please try again.", "error");
  }
}

function updateSoundToggle() {
  const btn = $id("soundToggle");
  if (!btn) return;
  btn.innerHTML = isSoundEnabled()
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 9v6h4l5 4V5L9 9H5Z"/><path d="M17 9.5a4 4 0 0 1 0 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m5 9 4 6h4l5 4V5l-5 4H9L5 3"/></svg>';
  btn.setAttribute("aria-label", isSoundEnabled() ? "Sound on" : "Sound off");
  btn.title = isSoundEnabled() ? "Sound on" : "Sound off";
}

function toggleDropdown(id, buttonId) {
  const menu = $id(id);
  const button = $id(buttonId);
  if (!menu) return;
  const open = menu.hidden;
  document.querySelectorAll(".dropdown-menu").forEach((el) => { if (el !== menu) el.hidden = true; });
  menu.hidden = !open;
  button?.setAttribute("aria-expanded", String(open));
}

/* ===================== Requests ===================== */
function updateRequestsBadge(count) {
  const badge = $id("requestsBadge");
  if (!badge) return;
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count <= 0;
}

function renderMessageRequests(requests) {
  const container = $id("requestsList");
  if (!container) return;
  if (!requests.length) {
    container.innerHTML = '<div class="empty-state">No new requests.<br><span>New connection requests will appear here.</span></div>';
    return;
  }
  container.innerHTML = requests.map((req) => `
    <div class="request-item" data-request-id="${escapeHtml(req.id)}">
      ${avatarHtml({ name: req.senderName, email: req.senderEmail }, { dot: false })}
      <div class="meta"><strong>${escapeHtml(req.senderName || req.senderEmail || "User")}</strong><span class="email">${escapeHtml(req.senderEmail || "")}</span><span class="subtitle">Wants to start a conversation</span></div>
      <div class="actions"><button class="btn btn-sm btn-primary accept-request" data-request-id="${escapeHtml(req.id)}">Accept</button><button class="btn btn-sm btn-soft decline-request" data-request-id="${escapeHtml(req.id)}">Decline</button></div>
    </div>`).join("");
  container.querySelectorAll(".request-item").forEach((el, index) => {
    const req = requests[index];
    paintAvatar(el.querySelector(".avatar"), { name: req.senderName, email: req.senderEmail });
  });
  container.querySelectorAll(".accept-request").forEach((button) => button.addEventListener("click", async () => {
    playClick();
    const req = requests.find((item) => item.id === button.dataset.requestId);
    if (!req) return;
    button.disabled = true; button.textContent = "Accepting…";
    const conversationId = await acceptMessageRequest(req.id, req, currentUser);
    if (conversationId) {
      closeModal("requestsModal");
      await openChatById(conversationId);
    } else {
      button.disabled = false; button.textContent = "Accept";
    }
  }));
  container.querySelectorAll(".decline-request").forEach((button) => button.addEventListener("click", async () => {
    playClick();
    button.disabled = true; button.textContent = "Declining…";
    const ok = await declineMessageRequest(button.dataset.requestId);
    if (!ok) { button.disabled = false; button.textContent = "Decline"; }
  }));
}

/* ===================== Search ===================== */
function matchesChat(user, term) {
  if (!term) return true;
  const name = String(user?.name || "").toLowerCase();
  const email = String(user?.email || "").toLowerCase();
  return name.includes(term) || email.includes(term);
}

async function loadNewChatSearch(term) {
  const box = $id("newChatResults");
  if (!box) return;
  if (!term) {
    box.innerHTML = '<div class="empty-state">Search for a person to send a request.</div>';
    return;
  }
  if (!isSearchValid(term)) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(getSearchMessage(term))}</div>`;
    return;
  }
  box.innerHTML = '<div class="empty-state">Searching…</div>';
  try {
    const snap = await getDocs(query(collection(db, "users"), orderBy("emailLower"), startAt(term), endAt(`${term}\uf8ff`), limit(20)));
    const matches = snap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => u.uid !== currentUser.uid);
    if (!matches.length) {
      box.innerHTML = `<div class="empty-state">No account found for “${escapeHtml(term)}”.</div>`;
      return;
    }
    box.innerHTML = matches.map((user) => {
      const alreadyConnected = conversations.some((c) => c.members?.includes(user.uid));
      const blockedByMe = currentBlockedUsers.includes(user.uid);
      const disabled = blockedByMe;
      const buttonText = disabled ? "Unavailable" : alreadyConnected ? "Open chat" : "Send request";
      return `
        <div class="new-person-row" data-uid="${escapeHtml(user.uid)}">
          ${avatarHtml(user, { dot: false })}
          <div class="meta"><strong>${escapeHtml(user.name || user.email || "User")}</strong><span>${escapeHtml(user.email || "")}</span></div>
          <button class="btn ${disabled ? "btn-soft" : "btn-primary"} btn-sm new-chat-action" ${disabled ? "disabled" : ""}>${buttonText}</button>
        </div>`;
    }).join("");
    box.querySelectorAll(".new-person-row").forEach((row, index) => {
      paintAvatar(row.querySelector(".avatar"), matches[index]);
      row.querySelector(".new-chat-action")?.addEventListener("click", async () => {
        const user = matches[index];
        playClick();
        const button = row.querySelector(".new-chat-action");
        if (!button || button.disabled) return;
        button.disabled = true; button.textContent = "Working…";
        const result = await sendMessageRequest(currentUser, user.uid, user);
        if (result?.alreadyExists) {
          closeModal("newChatModal");
          $id("newChatSearch").value = "";
          await openChatById(result.conversationId);
        } else if (result) {
          button.textContent = "Sent ✓";
          setTimeout(() => { closeModal("newChatModal"); $id("newChatSearch").value = ""; }, 700);
        } else {
          button.disabled = false; button.textContent = "Send request";
        }
      });
    });
  } catch (error) {
    console.error("New chat search failed:", error);
    box.innerHTML = '<div class="empty-state">Search is unavailable right now. Please try again.</div>';
  }
}

/* ===================== Conversation list ===================== */
function listenConversations() {
  unsubscribeConversations?.();
  const q = query(collection(db, "conversations"), where("members", "array-contains", currentUser.uid), limit(50));
  unsubscribeConversations = onSnapshot(q, (snap) => {
    conversations = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.lastMessageTime?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0) - (a.lastMessageTime?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0));
    conversations.forEach((conversation) => ensureUserListener(otherUid(conversation)));
    renderChatList();
    if (!startupCleanupStarted) {
      startupCleanupStarted = true;
      cleanupAllVisibleConversations().catch(() => {});
    }
  }, (error) => {
    console.error("Conversation listener failed:", error);
    $id("chatList").innerHTML = '<div class="empty-state">Chats could not be loaded.<br><span>Check Firebase connection and rules.</span></div>';
  });
}
function otherUid(conversation) {
  return Array.isArray(conversation.members) ? conversation.members.find((uid) => uid !== currentUser.uid) : null;
}
function ensureUserListener(uid) {
  if (!uid || userListeners.has(uid)) return;
  const entry = { unsub: null, data: null };
  entry.unsub = onSnapshot(doc(db, "users", uid), (snap) => {
    entry.data = snap.exists() ? { uid, ...snap.data() } : { uid };
    renderChatList();
    if (activeUser?.uid === uid) {
      activeUser = { ...activeUser, ...entry.data };
      refreshChatHeader();
    }
  }, (error) => console.warn("User listener failed:", uid, error));
  userListeners.set(uid, entry);
}
function renderChatList() {
  const box = $id("chatList");
  if (!box) return;
  const filtered = conversations.filter((conversation) => {
    const uid = otherUid(conversation);
    const user = userListeners.get(uid)?.data || { uid };
    return matchesChat(user, chatSearchTerm);
  });
  if (!filtered.length) {
    box.innerHTML = chatSearchTerm
      ? `<div class="empty-state">No conversations match “${escapeHtml(chatSearchTerm)}”.</div>`
      : '<div class="empty-state big">Your inbox is quiet.<br><span>Start a new chat to connect.</span></div>';
    return;
  }
  box.innerHTML = filtered.map((conversation) => {
    const uid = otherUid(conversation);
    const user = userListeners.get(uid)?.data || { uid, name: "Conversation" };
    const unread = Number(conversation.unread?.[currentUser.uid] || 0);
    const whenDate = conversation.lastMessageTime?.toDate?.() || conversation.createdAt?.toDate?.();
    const preview = conversation.lastMessage ? previewText({ type: conversation.lastMessageType, text: conversation.lastMessage }, { isMine: conversation.lastMessageSenderId === currentUser.uid }) : "No messages yet";
    const blocked = currentBlockedUsers.includes(uid);
    return `
      <button class="chat-item ${activeConversationId === conversation.id ? "active" : ""} ${blocked ? "blocked-chat" : ""}" data-conversation-id="${escapeHtml(conversation.id)}" type="button">
        ${avatarHtml(user, { dot: true })}
        <span class="meta">
          <span class="top-line"><strong>${escapeHtml(user.name || user.email || "User")}</strong><span class="time">${escapeHtml(whenDate ? formatWhen(whenDate) : "")}</span></span>
          <span class="preview-line"><span class="text">${escapeHtml(blocked ? "Blocked" : preview)}</span>${unread > 0 && !blocked ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}</span>
        </span>
      </button>`;
  }).join("");

  box.querySelectorAll(".chat-item").forEach((el) => el.addEventListener("click", () => {
    const c = conversations.find((item) => item.id === el.dataset.conversationId);
    if (!c) return;
    const uid = otherUid(c);
    playClick();
    openChatById(c.id, uid);
  }));
  filtered.forEach((conversation) => {
    const uid = otherUid(conversation);
    const row = box.querySelector(`[data-conversation-id="${CSS.escape(conversation.id)}"]`);
    const user = userListeners.get(uid)?.data || { uid };
    paintAvatar(row?.querySelector(".avatar"), { photoURL: user.photoURL, name: user.name, email: user.email });
    row?.querySelector(".status-dot")?.classList.toggle("online", !!user.isOnline);
  });
}

/* ===================== Active conversation ===================== */
async function openChatById(conversationId, hintedUid = null) {
  if (!currentUser || !conversationId) return;
  try {
    const snap = await getDoc(doc(db, "conversations", conversationId));
    if (!snap.exists()) { showToast("Conversation is not available yet.", "info"); return; }
    const members = snap.data().members || [];
    if (members.length !== 2 || !members.includes(currentUser.uid)) { showToast("You don't have access to this conversation.", "error"); return; }
    const other = members.find((uid) => uid !== currentUser.uid) || hintedUid;
    if (!other) return;
    const userSnap = await getDoc(doc(db, "users", other));
    if (!userSnap.exists()) { showToast("User profile not found.", "error"); return; }
    activeConversationId = conversationId;
    activeUser = { uid: other, ...userSnap.data() };
    ensureUserListener(other);
    refreshChatHeader();
    setComposerState();
    $id("chatMoreBtn").disabled = false;
    $id("app")?.classList.add("chat-open");
    clearImagePreview();
    renderChatList();
    await markRead(conversationId);
    listenMessages();
  } catch (error) {
    console.error("Could not open chat:", error);
    showToast(error?.code === "permission-denied" ? "You don't have access to this chat." : "Could not open this chat.", "error");
  }
}
function refreshChatHeader() {
  if (!activeUser) return;
  const live = userListeners.get(activeUser.uid)?.data;
  if (live) activeUser = { ...activeUser, ...live };
  $id("chatName").textContent = activeUser.name || activeUser.email || "User";
  const blockedByMe = currentBlockedUsers.includes(activeUser.uid);
  const blockedMe = Array.isArray(activeUser.blockedUsers) && activeUser.blockedUsers.includes(currentUser.uid);
  const blocked = blockedByMe || blockedMe;
  $id("chatStatus").textContent = blockedByMe ? "Blocked by you" : blockedMe ? "You can't message this user" : activeUser.isOnline ? "Active now" : formatLastSeen(activeUser.lastSeen?.toDate?.() || null);
  const pill = $id("chatStatusPill");
  pill.hidden = !activeUser.isOnline || blocked;
  if (!pill.hidden) pill.textContent = "Online";
  $id("chatStatusDot").classList.toggle("online", !!activeUser.isOnline && !blocked);
  paintAvatar($id("chatAvatar"), { photoURL: activeUser.photoURL, name: activeUser.name, email: activeUser.email, preset: "avatarSm" });
  renderChatMoreMenu();
  setComposerState();
}
function isBlockedByEither(user = activeUser) {
  return !!(user && (currentBlockedUsers.includes(user.uid) || (Array.isArray(user.blockedUsers) && user.blockedUsers.includes(currentUser.uid))));
}
function setComposerState() {
  const blocked = isBlockedByEither();
  const enabled = !!activeUser && !!activeConversationId && !blocked;
  $id("messageInput").disabled = !enabled;
  $id("attachBtn").disabled = !enabled;
  $id("messageForm").querySelector("button[type=submit]").disabled = !enabled;
  $id("messageInput").placeholder = blocked ? "Messaging is blocked" : "Write a message…";
  const notice = $id("blockedNotice");
  if (blocked) {
    notice.hidden = false;
    notice.innerHTML = `<span>${icon.block}</span><span>${currentBlockedUsers.includes(activeUser.uid) ? "You blocked this person." : "This person has blocked you."}</span>`;
  } else notice.hidden = true;
}
function renderChatMoreMenu() {
  const menu = $id("chatMoreMenu");
  if (!menu || !activeUser) return;
  const blockedByMe = currentBlockedUsers.includes(activeUser.uid);
  menu.innerHTML = `
    <div class="dropdown-label">Conversation</div>
    <button class="dropdown-item ${blockedByMe ? "" : "danger-item"}" id="blockToggleBtn">
      ${blockedByMe ? icon.unlock : icon.block}<span>${blockedByMe ? "Unblock user" : "Block user"}</span>
    </button>`;
  $id("blockToggleBtn")?.addEventListener("click", async () => {
    playClick();
    menu.hidden = true;
    await toggleBlockUser(activeUser.uid, !blockedByMe);
  });
}
async function loadBlockedUsers() {
  if (!currentUser) return;
  try {
    const snap = await getDocs(collection(db, "users", currentUser.uid, "blockedUsers"));
    currentBlockedUsers = snap.docs.map((d) => d.id);
  } catch (error) {
    console.warn("Could not load blocked users:", error);
    currentBlockedUsers = [];
  }
}
async function toggleBlockUser(uid, shouldBlock) {
  if (!currentUser || !uid) return;
  try {
    const blockedRef = doc(db, "users", currentUser.uid, "blockedUsers", uid);
    if (shouldBlock) await setDoc(blockedRef, { uid, createdAt: serverTimestamp() });
    else await deleteDoc(blockedRef);
    currentBlockedUsers = shouldBlock ? [...new Set([...currentBlockedUsers, uid])] : currentBlockedUsers.filter((id) => id !== uid);
    renderChatList();
    refreshChatHeader();
    showToast(shouldBlock ? "User blocked" : "User unblocked", "info");
  } catch (error) {
    console.error("Block toggle failed:", error);
    showToast(error?.code === "permission-denied" ? "You don't have permission to change block settings." : "Could not update block setting.", "error");
  }
}

/* ===================== Read receipts + messages ===================== */
async function markRead(conversationId) {
  if (!conversationId || !currentUser) return;
  try {
    await updateDoc(doc(db, "conversations", conversationId), { [`unread.${currentUser.uid}`]: 0 });
  } catch (error) { console.warn("Could not mark conversation read:", error); }
  await markIncomingMessagesRead();
}
async function markIncomingMessagesRead() {
  if (!activeConversationId || !currentUser || !currentMessages.length) return;
  const pending = currentMessages.filter((m) => m.receiverId === currentUser.uid && !m.readBy?.[currentUser.uid] && !isDeletedForUser(m, currentUser.uid));
  if (!pending.length) return;
  try {
    const batch = writeBatch(db);
    pending.slice(0, 450).forEach((message) => {
      batch.update(doc(db, "conversations", activeConversationId, "messages", message.id), { [`readBy.${currentUser.uid}`]: serverTimestamp() });
    });
    await batch.commit();
  } catch (error) { console.warn("Could not mark messages read:", error); }
}
function listenMessages() {
  unsubscribeMessages?.();
  cleanupInterval?.();
  currentMessages = [];
  const token = ++messageListenerToken;
  initialMessageSnapshot = true;
  const messagesRef = collection(db, "conversations", activeConversationId, "messages");
  const q = query(messagesRef, orderBy("createdAt"), limit(200));

  unsubscribeMessages = onSnapshot(q, (snap) => {
    if (token !== messageListenerToken) return;
    const nearBottom = isNearBottom();
    currentMessages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMessages();

    if (!initialMessageSnapshot) {
      const hasIncoming = snap.docChanges().some((change) => change.type === "added" && change.doc.data().senderId !== currentUser.uid);
      if (hasIncoming && document.visibilityState === "visible") playReceive();
    }
    const shouldScroll = initialMessageSnapshot || snap.docChanges().some((change) => change.type === "added" && change.doc.data().senderId === currentUser.uid);
    initialMessageSnapshot = false;

    if (shouldScroll || nearBottom) requestAnimationFrame(() => { const box = $id("messages"); if (box) box.scrollTop = box.scrollHeight; });
    if (document.visibilityState === "visible") markIncomingMessagesRead().catch(() => {});
    cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc).catch(() => {});
  }, (error) => {
    console.error("Message listener failed:", error);
    $id("messages").innerHTML = `<div class="empty-state">Messages couldn't be loaded.<br><span>${escapeHtml(error?.code || "Check Firebase rules.")}</span></div>`;
  });
  cleanupInterval = startPeriodicCleanup(db, activeConversationId, () => currentMessages, currentUser.uid, updateDoc);
}
function isNearBottom() {
  const box = $id("messages");
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}
function renderMessages() {
  const box = $id("messages");
  if (!box) return;
  const visible = currentMessages.filter((m) => !isDeletedForUser(m, currentUser.uid) && !shouldExpireMessage(m, currentUser.uid));
  box.innerHTML = "";
  if (!visible.length) {
    box.innerHTML = '<div class="empty-state big">No messages yet.<br><span>Send a message to start the conversation.</span></div>';
    return;
  }
  const fragment = document.createDocumentFragment();
  visible.forEach((message) => fragment.appendChild(buildMessageElement(message)));
  box.appendChild(fragment);
}
function buildMessageElement(message) {
  const outgoing = message.senderId === currentUser.uid;
  const saved = isSavedByUser(message, currentUser.uid);
  const time = message.createdAt?.toDate ? formatTime(message.createdAt.toDate()) : "";
  const el = document.createElement("article");
  el.className = `message ${outgoing ? "outgoing" : "incoming"} ${saved ? "saved" : ""}`;
  el.dataset.messageId = message.id;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  if (message.type === "image" && isTrustedImageUrl(message.imageURL)) {
    el.classList.add("image-message");
    bubble.innerHTML = `<img src="${escapeHtml(imageUrl(message.imageURL, "chat"))}" alt="Shared image" loading="lazy"><div class="message-meta"><small>${escapeHtml(time)}</small>${outgoing ? `<span class="delivery-check">${icon.check}</span>` : ""}</div>`;
    bubble.querySelector("img")?.addEventListener("click", () => openLightbox(message.imageURL));
  } else {
    bubble.innerHTML = `<p>${escapeHtml(message.text || "Attachment unavailable")}</p><div class="message-meta"><small>${escapeHtml(time)}</small>${outgoing ? `<span class="delivery-check">${icon.check}</span>` : ""}</div>`;
  }
  el.appendChild(bubble);

  if (saved) {
    const bookmark = document.createElement("span");
    bookmark.className = "bookmark-icon";
    bookmark.innerHTML = icon.bookmark;
    bookmark.title = "Saved";
    el.appendChild(bookmark);
  }

  const actionTrigger = document.createElement("button");
  actionTrigger.className = "message-more";
  actionTrigger.type = "button";
  actionTrigger.setAttribute("aria-label", "Message actions");
  actionTrigger.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  actionTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    playClick();
    showMessageActions(el, message, outgoing, actionTrigger);
  });
  el.appendChild(actionTrigger);

  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showMessageActions(el, message, outgoing, actionTrigger);
  });
  return el;
}
function showMessageActions(messageEl, message, isOutgoing, anchor) {
  closeMessageActionMenus();
  const menu = document.createElement("div");
  menu.className = "message-action-menu";
  const saved = isSavedByUser(message, currentUser.uid);
  menu.innerHTML = `
    <button class="menu-item save-msg">${icon.bookmark}<span>${saved ? "Unsave message" : "Save message"}</span></button>
    ${isOutgoing ? `<button class="menu-item danger-item delete-msg">${icon.trash}<span>Delete for everyone</span></button>` : ""}
    <button class="menu-item danger-item delete-for-me">${icon.trash}<span>Delete for me</span></button>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top = rect.bottom + 6 + menuRect.height > window.innerHeight ? rect.top - menuRect.height - 6 : rect.bottom + 6;
  const left = Math.min(Math.max(8, rect.right - menuRect.width), window.innerWidth - menuRect.width - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;
  menu.querySelector(".save-msg")?.addEventListener("click", async () => {
    playClick(); await toggleSaveMessage(message.id, saved); menu.remove();
  });
  menu.querySelector(".delete-msg")?.addEventListener("click", async () => {
    playDelete(); await deleteMessageForEveryone(message.id); menu.remove();
  });
  menu.querySelector(".delete-for-me")?.addEventListener("click", async () => {
    playDelete(); await deleteMessageForMe(message.id, messageEl); menu.remove();
  });
}
function closeMessageActionMenus() { document.querySelectorAll(".message-action-menu").forEach((menu) => menu.remove()); }

async function toggleSaveMessage(messageId, currentlySaved) {
  if (!activeConversationId || !currentUser) return false;
  try {
    const msgRef = doc(db, "conversations", activeConversationId, "messages", messageId);
    await updateDoc(msgRef, { savedBy: currentlySaved ? arrayRemove(currentUser.uid) : arrayUnion(currentUser.uid) });
    showToast(currentlySaved ? "Message unsaved" : "Message saved 🔖", currentlySaved ? "info" : "success");
    if (!currentlySaved) playSave();
    return true;
  } catch (error) {
    console.error("Save message failed:", error);
    showToast(error?.code === "permission-denied" ? "You don't have permission to save this message." : "Failed to update message", "error");
    return false;
  }
}
async function deleteMessageForEveryone(messageId) {
  if (!activeConversationId || !currentUser) return false;
  if (!confirm("Delete this message for everyone?")) return false;
  try {
    const messageRef = doc(db, "conversations", activeConversationId, "messages", messageId);
    await deleteDoc(messageRef);
    showToast("Message deleted for everyone", "info");
    return true;
  } catch (error) {
    console.error("Delete for everyone failed:", error);
    showToast(error?.code === "permission-denied" ? "Only the sender can delete this message." : "Could not delete the message.", "error");
    return false;
  }
}
async function deleteMessageForMe(messageId, messageEl) {
  if (!activeConversationId || !currentUser) return false;
  messageEl.classList.add("deleting");
  try {
    await updateDoc(doc(db, "conversations", activeConversationId, "messages", messageId), { deletedFor: arrayUnion(currentUser.uid) });
    showToast("Message deleted for you", "info");
    return true;
  } catch (error) {
    console.error("Delete for me failed:", error);
    messageEl.classList.remove("deleting");
    showToast(error?.code === "permission-denied" ? "You don't have permission to delete this message for you." : "Failed to delete message for you", "error");
    return false;
  }
}

/* ===================== Send messages ===================== */
async function handleMessageSubmit(event) {
  event.preventDefault();
  if (sendingMessage || !activeUser || !activeConversationId || isBlockedByEither()) return;
  const input = $id("messageInput");
  const text = input.value.trim();
  if (!text) return;
  sendingMessage = true;
  const sendButton = $id("messageForm").querySelector("button[type=submit]");
  sendButton.disabled = true;
  input.value = "";
  autoGrowComposer();
  try {
    playSend();
    await sendMessage({ type: "text", text });
    input.focus();
  } catch (error) {
    console.error("Send message failed:", error);
    input.value = text;
    autoGrowComposer();
    showToast(error?.code === "permission-denied" ? "Message blocked by chat permissions." : "Message could not be sent. Please try again.", "error");
  } finally {
    sendingMessage = false;
    setComposerState();
  }
}
async function sendMessage({ type, text, imageURL }) {
  if (!activeConversationId || !activeUser || !currentUser) throw new Error("No active conversation");
  if (isBlockedByEither()) throw new Error("Blocked");
  const conversationRef = doc(db, "conversations", activeConversationId);
  const conversationSnap = await getDoc(conversationRef);
  if (!conversationSnap.exists()) throw new Error("Conversation does not exist");
  const members = conversationSnap.data().members || [];
  if (!members.includes(currentUser.uid) || !members.includes(activeUser.uid)) throw new Error("Conversation membership mismatch");

  // One atomic batch prevents the two-device race where the message exists but the conversation metadata does not.
  const batch = writeBatch(db);
  const messageRef = doc(collection(db, "conversations", activeConversationId, "messages"));
  batch.set(messageRef, {
    senderId: currentUser.uid,
    receiverId: activeUser.uid,
    type,
    ...(type === "image" ? { imageURL } : { text: text.slice(0, 5000) }),
    createdAt: serverTimestamp(),
    savedBy: [],
    deletedFor: [],
    readBy: {}
  });
  batch.update(conversationRef, {
    lastMessage: type === "image" ? "" : text.slice(0, 500),
    lastMessageType: type,
    lastMessageSenderId: currentUser.uid,
    lastMessageTime: serverTimestamp(),
    [`unread.${activeUser.uid}`]: increment(1)
  });
  await batch.commit();
}

/* ===================== Image sending ===================== */
async function handleImageSelection() {
  const file = $id("fileInput").files?.[0];
  $id("fileInput").value = "";
  if (!file || !activeUser || !activeConversationId || isBlockedByEither()) return;
  try { await validateImageFile(file); }
  catch (error) { showToast(error instanceof UploadError ? error.userMessage : UPLOAD_MESSAGES.invalid, "error"); return; }
  pendingImageFile = file;
  pendingImageUrl = URL.createObjectURL(file);
  $id("imagePreviewThumb").src = pendingImageUrl;
  $id("imagePreviewStatus").textContent = "Your image is ready.";
  $id("imagePreviewProgress").style.width = "0%";
  $id("imagePreviewBar").hidden = false;
  $id("imagePreviewBar").classList.remove("uploading");
}
function cancelImagePreview() {
  playClick();
  uploadController?.abort();
  clearImagePreview();
}
async function sendPendingImage() {
  if (!pendingImageFile || !activeUser || !activeConversationId || isBlockedByEither()) return;
  const file = pendingImageFile;
  const bar = $id("imagePreviewBar");
  bar.classList.add("uploading");
  $id("imagePreviewSend").disabled = true;
  $id("imagePreviewStatus").textContent = "Uploading…";
  uploadController = new AbortController();
  try {
    const url = await uploadImageToCloudinary(file, { signal: uploadController.signal, onProgress: (progress) => { $id("imagePreviewProgress").style.width = `${Math.round(progress * 100)}%`; } });
    await sendMessage({ type: "image", imageURL: url });
    playSend();
    showToast("Image sent", "success");
    clearImagePreview();
  } catch (error) {
    if (error?.kind === "aborted") return;
    console.error("Image send failed:", error);
    $id("imagePreviewStatus").textContent = error instanceof UploadError ? error.userMessage : "Image could not be sent.";
    $id("imagePreviewSend").disabled = false;
  }
}
function clearImagePreview() {
  if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  pendingImageFile = null;
  pendingImageUrl = null;
  uploadController = null;
  const bar = $id("imagePreviewBar");
  if (!bar) return;
  bar.hidden = true;
  bar.classList.remove("uploading");
  $id("imagePreviewSend").disabled = false;
  $id("imagePreviewThumb").src = "";
}
function autoGrowComposer() {
  const input = $id("messageInput");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

/* ===================== Saved messages ===================== */
async function renderSavedMessages() {
  const box = $id("savedList");
  if (!box || !currentUser) return;
  box.innerHTML = '<div class="empty-state">Loading saved messages…</div>';
  try {
    const saved = [];
    for (const conversation of conversations) {
      const partnerId = otherUid(conversation);
      const snap = await getDocs(query(collection(db, "conversations", conversation.id, "messages"), orderBy("createdAt", "desc"), limit(200)));
      const partner = userListeners.get(partnerId)?.data || { uid: partnerId, name: "Conversation" };
      snap.docs.forEach((d) => {
        const message = { id: d.id, ...d.data(), conversationId: conversation.id };
        if (!isDeletedForUser(message, currentUser.uid) && isSavedByUser(message, currentUser.uid)) saved.push({ message, partner });
      });
    }
    saved.sort((a, b) => (b.message.createdAt?.toMillis?.() ?? 0) - (a.message.createdAt?.toMillis?.() ?? 0));
    if (!saved.length) { box.innerHTML = '<div class="empty-state big">No saved messages yet.<br><span>Use the ••• menu on any message.</span></div>'; return; }
    box.innerHTML = saved.map(({ message, partner }) => `
      <button class="saved-item" data-conversation-id="${escapeHtml(message.conversationId)}" type="button">
        ${avatarHtml(partner, { dot: false })}
        <span class="meta"><span class="top-line"><strong>${escapeHtml(partner.name || partner.email || "Conversation")}</strong><span class="time">${escapeHtml(message.createdAt?.toDate ? formatWhen(message.createdAt.toDate()) : "")}</span></span><span class="preview-line"><span class="text">${escapeHtml(message.type === "image" ? "📷 Photo" : String(message.text || ""))}</span></span></span>
        <span class="saved-bookmark">${icon.bookmark}</span>
      </button>`).join("");
    box.querySelectorAll(".saved-item").forEach((button) => button.addEventListener("click", async () => {
      playClick(); closeModal("savedModal"); await openChatById(button.dataset.conversationId);
    }));
    saved.forEach((entry, index) => {
      const row = box.querySelectorAll(".saved-item")[index];
      paintAvatar(row?.querySelector(".avatar"), entry.partner);
    });
  } catch (error) {
    console.error("Saved messages load failed:", error);
    box.innerHTML = `<div class="empty-state">Saved messages could not be loaded.<br><span>${escapeHtml(error?.code || "Try again")}</span></div>`;
  }
}

/* ===================== Retention ===================== */
async function cleanupAllVisibleConversations() {
  if (!currentUser || !conversations.length) return;
  const mode = getRetentionMode();
  if (!mode) return;
  // Lightweight startup cleanup: last 12 chats × 100 newest messages. Chat-open cleanup handles the active room too.
  for (const conversation of conversations.slice(0, 12)) {
    try {
      const snap = await getDocs(query(collection(db, "conversations", conversation.id, "messages"), orderBy("createdAt", "desc"), limit(100)));
      const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      await cleanupExpiredMessages(db, conversation.id, messages, currentUser.uid, updateDoc);
    } catch (error) { console.warn("Retention scan failed:", conversation.id, error); }
  }
}

