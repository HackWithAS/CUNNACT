import {
  auth, db, onAuthStateChanged, signOut,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection,
  query, where, orderBy, startAt, endAt, limit, onSnapshot, serverTimestamp, increment
} from "./firebase.js";
import {
  uploadImageToCloudinary, validateImageFile, UploadError,
  MESSAGES as UPLOAD_MESSAGES, isTrustedImageUrl, imageUrl
} from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { $, escapeHtml, formatTime, formatWhen, formatLastSeen, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { normalizeSearch, isSearchValid, getSearchMessage, SEARCH_MIN_LENGTH } from "./users.js";
import {
  listenMessageRequests, sendMessageRequest, acceptMessageRequest, declineMessageRequest
} from "./requests.js";
import { playClick, playSend, playReceive, isSoundEnabled, toggleSound } from "./sound.js";
import {
  getRetentionMode, loadRetentionMode, shouldExpireMessage, cleanupExpiredMessages,
  startPeriodicCleanup, isSavedByUser, isDeletedForUser
} from "./retention.js";

let currentUser = null;
let activeUser = null;
let activeConversationId = null;
let unsubscribeMessages = null;
let unsubscribeConversations = null;
const userListeners = new Map();
let conversations = [];
let currentMessages = [];
let pendingImageFile = null;
let pendingImageUrl = null;
let uploadController = null;
let cleanupInterval = null;

const $id = (id) => document.getElementById(id);

/* ===================== Auth bootstrap ===================== */

onAuthStateChanged(auth, async (user) => {
  try {
    if (!user) {
      location.replace("login.html");
      return;
    }

    currentUser = user;
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);
    const data = snap.exists() ? snap.data() : {};
    const name = data.name || user.displayName || user.email || "User";

    await setDoc(userRef, {
      uid: user.uid,
      name,
      email: user.email || data.email || "",
      emailLower: String(user.email || data.email || "").toLowerCase(),
      photoURL: data.photoURL || user.photoURL || "",
      bio: data.bio || "",
      retentionMode: data.retentionMode || "24hours",
      isOnline: true,
      lastSeen: serverTimestamp()
    }, { merge: true });

    await loadRetentionMode(user.uid);

    $id("currentUserName").textContent = name;
    $id("currentUserEmail").textContent = user.email || "";
    $id("currentUserStatus").textContent = "Online";
    paintAvatar($id("currentUserAvatar"), {
      photoURL: data.photoURL || user.photoURL,
      name,
      email: user.email,
      preset: "avatarSm"
    });

    updateSoundToggle();
    bindModalEvents();

    listenMessageRequests(currentUser, (requests) => {
      updateRequestsBadge(requests.length);
      renderMessageRequests(requests);
    });

    listenConversations();
    await cleanupAllVisibleConversations();

    const gate = $id("authGate");
    if (gate) gate.hidden = true;
    $id("app")?.classList.remove("auth-checking");
  } catch (error) {
    console.error("CUNNACT startup failed:", error);
    const gate = $id("authGate");
    if (gate) {
      gate.hidden = false;
      gate.innerHTML = `<div class="auth-gate-card"><strong>Couldn’t load CUNNACT</strong><span>Refresh the page and try again.</span><button id="retryBtn" class="btn btn-primary">Refresh</button></div>`;
      $id("retryBtn")?.addEventListener("click", () => location.reload());
    }
  }
});

/* ===================== Presence / lifecycle ===================== */

document.addEventListener("visibilitychange", async () => {
  if (!currentUser) return;
  const visible = document.visibilityState === "visible";
  updateDoc(doc(db, "users", currentUser.uid), {
    isOnline: visible,
    lastSeen: serverTimestamp()
  }).catch(() => {});

  if (visible) {
    if (activeConversationId && currentMessages.length) {
      await cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc);
    }
    await cleanupAllVisibleConversations();
  }
});

window.addEventListener("pagehide", () => {
  if (!currentUser) return;
  updateDoc(doc(db, "users", currentUser.uid), {
    isOnline: false,
    lastSeen: serverTimestamp()
  }).catch(() => {});
});

/* ===================== Static controls ===================== */

$id("logoutBtn")?.addEventListener("click", async () => {
  playClick();
  try {
    if (currentUser) {
      await setDoc(doc(db, "users", currentUser.uid), {
        isOnline: false,
        lastSeen: serverTimestamp()
      }, { merge: true });
    }
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error);
    showToast("Could not log out. Please try again.", "error");
  }
});

$id("profileBtn")?.addEventListener("click", () => {
  playClick();
  location.href = "profile.html";
});

$id("backBtn")?.addEventListener("click", () => {
  playClick();
  $id("app")?.classList.remove("chat-open");
});

$id("soundToggle")?.addEventListener("click", () => {
  const enabled = toggleSound();
  if (enabled) playClick();
  updateSoundToggle();
});

function updateSoundToggle() {
  const btn = $id("soundToggle");
  if (!btn) return;
  const enabled = isSoundEnabled();
  btn.textContent = enabled ? "🔊" : "🔇";
  btn.setAttribute("aria-label", enabled ? "Sound on" : "Sound off");
  btn.title = enabled ? "Sound on" : "Sound off";
}

/* ===================== Requests modal ===================== */

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
    container.innerHTML = `<div class="empty-state">No new requests.</div>`;
    return;
  }

  container.innerHTML = requests.map((req) => `
    <div class="request-item" data-request-id="${escapeHtml(req.id)}">
      ${avatarHtml({ name: req.senderName, email: req.senderEmail }, { dot: false })}
      <div class="meta">
        <strong>${escapeHtml(req.senderName || req.senderEmail || "User")}</strong>
        <span class="email">${escapeHtml(req.senderEmail || "")}</span>
        <span class="subtitle">Wants to start a conversation</span>
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-primary accept-request" data-request-id="${escapeHtml(req.id)}">Accept</button>
        <button class="btn btn-sm btn-ghost decline-request" data-request-id="${escapeHtml(req.id)}">Decline</button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".request-item").forEach((el, index) => {
    const req = requests[index];
    paintAvatar(el.querySelector(".avatar"), {
      photoURL: "",
      name: req.senderName,
      email: req.senderEmail
    });
  });

  container.querySelectorAll(".accept-request").forEach((button) => {
    button.addEventListener("click", async () => {
      playClick();
      const request = requests.find((req) => req.id === button.dataset.requestId);
      if (!request) return;
      button.disabled = true;
      button.textContent = "Accepting…";
      const conversationId = await acceptMessageRequest(request.id, request, currentUser);
      if (conversationId) {
        closeModal("requestsModal");
        await openChatById(conversationId);
      } else {
        button.disabled = false;
        button.textContent = "Accept";
      }
    });
  });

  container.querySelectorAll(".decline-request").forEach((button) => {
    button.addEventListener("click", async () => {
      playClick();
      button.disabled = true;
      button.textContent = "Declining…";
      const ok = await declineMessageRequest(button.dataset.requestId);
      if (!ok) {
        button.disabled = false;
        button.textContent = "Decline";
      }
    });
  });
}

function bindModalEvents() {
  $id("requestsBtn")?.addEventListener("click", async () => {
    playClick();
    openModal("requestsModal");
  });

  $id("savedBtn")?.addEventListener("click", async () => {
    playClick();
    openModal("savedModal");
    await renderSavedMessages();
  });

  document.querySelectorAll(".close-modal").forEach((button) => {
    button.onclick = () => {
      playClick();
      const modal = button.closest(".modal");
      if (modal) closeModal(modal.id);
    };
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    if (modal.dataset.bound === "true") return;
    modal.dataset.bound = "true";
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".modal:not([hidden])").forEach((modal) => closeModal(modal.id));
    document.querySelectorAll(".message-action-menu").forEach((menu) => menu.remove());
  });
}

function openModal(id) {
  const modal = $id(id);
  if (modal) modal.hidden = false;
}

function closeModal(id) {
  const modal = $id(id);
  if (modal) modal.hidden = true;
}

/* ===================== Search ===================== */

$id("userSearch")?.addEventListener("input", debounce((event) => {
  const term = normalizeSearch(event.target.value);
  loadSearch(term);
}, 220));

async function loadSearch(term) {
  const box = $id("searchResults");
  if (!box) return;

  if (!term) {
    box.innerHTML = "";
    return;
  }

  if (!isSearchValid(term)) {
    box.innerHTML = `<div class="empty-state">${escapeHtml(getSearchMessage(term))}</div>`;
    return;
  }

  box.innerHTML = `<div class="empty-state">Searching…</div>`;

  try {
    // Prefix search on email is server-side and does not load an arbitrary set of users.
    const normalizedSnap = await getDocs(query(
      collection(db, "users"),
      orderBy("emailLower"),
      startAt(term),
      endAt(`${term}\uf8ff`),
      limit(20)
    ));

    const legacySnap = normalizedSnap.size < 20
      ? await getDocs(query(
          collection(db, "users"),
          orderBy("email"),
          startAt(term),
          endAt(`${term}\uf8ff`),
          limit(20)
        ))
      : null;

    const matches = [...normalizedSnap.docs, ...(legacySnap?.docs || [])]
      .map((d) => ({ id: d.id, uid: d.id, ...d.data() }))
      .filter((user, index, all) => user.uid !== currentUser.uid && all.findIndex((x) => x.uid === user.uid) === index);

    if (!matches.length) {
      box.innerHTML = `<div class="empty-state">No people found for “${escapeHtml(term)}”.</div>`;
      return;
    }

    box.innerHTML = matches.map((user) => `
      <div class="row-item search-user" data-uid="${escapeHtml(user.uid)}" role="option" tabindex="0">
        ${avatarHtml(user, { dot: false })}
        <div class="meta">
          <div class="top-line"><strong>${escapeHtml(user.name || user.email || "User")}</strong></div>
          <div class="preview-line"><span class="bio">${escapeHtml(user.email || "")}</span></div>
        </div>
        <button class="btn btn-sm btn-primary send-request" data-uid="${escapeHtml(user.uid)}">Send Request</button>
      </div>
    `).join("");

    box.querySelectorAll(".search-user").forEach((el, index) => {
      const user = matches[index];
      paintAvatar(el.querySelector(".avatar"), {
        photoURL: user.photoURL,
        name: user.name,
        email: user.email
      });

      const openExistingOrSend = async () => {
        const button = el.querySelector(".send-request");
        button.disabled = true;
        button.textContent = "Sending…";
        const result = await sendMessageRequest(currentUser, user.uid, user);
        if (result?.alreadyExists) {
          $id("userSearch").value = "";
          box.innerHTML = "";
          await openChatById(result.conversationId);
          return;
        }
        if (result) {
          button.textContent = "Sent ✓";
          setTimeout(() => {
            $id("userSearch").value = "";
            box.innerHTML = "";
          }, 1200);
        } else {
          button.disabled = false;
          button.textContent = "Send Request";
        }
      };

      el.querySelector(".send-request")?.addEventListener("click", (event) => {
        event.stopPropagation();
        playClick();
        openExistingOrSend();
      });
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          playClick();
          openExistingOrSend();
        }
      });
    });
  } catch (error) {
    console.error("Search failed:", error);
    box.innerHTML = `<div class="empty-state">Search is unavailable right now.</div>`;
  }
}

/* ===================== Conversation list ===================== */

function listenConversations() {
  unsubscribeConversations?.();
  const q = query(
    collection(db, "conversations"),
    where("members", "array-contains", currentUser.uid),
    limit(50)
  );

  unsubscribeConversations = onSnapshot(q, (snap) => {
    conversations = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.lastMessageTime?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0)
        - (a.lastMessageTime?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0));

    conversations.forEach((conversation) => ensureUserListener(otherUid(conversation)));
    renderChatList();
    cleanupAllVisibleConversations().catch((error) => console.warn("Initial retention scan failed:", error));
  }, (error) => {
    console.error("Conversation listener failed:", error);
    $id("chatList").innerHTML = `<div class="empty-state">Chats could not be loaded. Check your Firebase connection and rules.</div>`;
  });
}

function otherUid(conversation) {
  return Array.isArray(conversation.members)
    ? conversation.members.find((uid) => uid !== currentUser.uid)
    : null;
}

function ensureUserListener(uid) {
  if (!uid || userListeners.has(uid)) return;
  const entry = { unsub: null, data: null };
  entry.unsub = onSnapshot(doc(db, "users", uid), (snap) => {
    entry.data = snap.exists() ? { uid, ...snap.data() } : { uid };
    renderChatList();
    if (activeUser?.uid === uid) refreshChatHeader();
  }, (error) => {
    console.warn("User listener failed:", uid, error);
  });
  userListeners.set(uid, entry);
}

function renderChatList() {
  const box = $id("chatList");
  if (!box) return;
  if (!conversations.length) {
    box.innerHTML = `<div class="empty-state"><p>Your inbox is quiet.</p><p>Find someone and start a conversation.</p></div>`;
    return;
  }

  box.innerHTML = conversations.map((conversation) => {
    const uid = otherUid(conversation);
    const user = userListeners.get(uid)?.data || { uid };
    const unread = Number(conversation.unread?.[currentUser.uid] || 0);
    const whenDate = conversation.lastMessageTime?.toDate?.() || conversation.createdAt?.toDate?.();
    const when = whenDate ? formatWhen(whenDate) : "";
    const preview = previewText(
      conversation.lastMessage ? {
        type: conversation.lastMessageType,
        text: conversation.lastMessage
      } : null,
      { isMine: conversation.lastMessageSenderId === currentUser.uid }
    );

    return `
      <div class="row-item chat-item ${activeConversationId === conversation.id ? "active" : ""}" data-uid="${escapeHtml(uid || "")}" role="option" tabindex="0">
        ${avatarHtml(user)}
        <div class="meta">
          <div class="top-line"><strong>${escapeHtml(user.name || user.email || "…")}</strong><span class="time">${escapeHtml(when)}</span></div>
          <div class="preview-line"><span class="text">${escapeHtml(preview)}</span>${unread > 0 ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}</div>
        </div>
      </div>`;
  }).join("");

  box.querySelectorAll(".chat-item").forEach((el, index) => {
    const conversation = conversations[index];
    const uid = otherUid(conversation);
    const user = userListeners.get(uid)?.data || { uid };
    paintAvatar(el.querySelector(".avatar"), {
      photoURL: user.photoURL,
      name: user.name,
      email: user.email
    });
    el.querySelector(".status-dot")?.classList.toggle("online", !!user.isOnline);

    const open = () => {
      playClick();
      openChat(uid);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
  });
}

/* ===================== Active conversation ===================== */

function refreshChatHeader() {
  if (!activeUser) return;
  const live = userListeners.get(activeUser.uid)?.data;
  if (live) activeUser = { ...activeUser, ...live };

  $id("chatName").textContent = activeUser.name || activeUser.email || "User";
  $id("chatStatus").textContent = activeUser.isOnline
    ? "Online"
    : formatLastSeen(activeUser.lastSeen?.toDate?.() || null);
  $id("chatStatusDot").classList.toggle("online", !!activeUser.isOnline);
  paintAvatar($id("chatAvatar"), {
    photoURL: activeUser.photoURL,
    name: activeUser.name,
    email: activeUser.email
  });
}

async function openChat(uid) {
  if (!currentUser || !uid || uid === currentUser.uid) return;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) {
      showToast("User not found.", "error");
      return;
    }
    activeUser = { uid, ...snap.data() };
    await openChatById(buildConversationId(currentUser.uid, uid));
  } catch (error) {
    console.error("Could not open chat:", error);
    showToast("Could not open this chat.", "error");
  }
}

async function openChatById(conversationId) {
  if (!currentUser || !conversationId) return;

  const conversationSnap = await getDoc(doc(db, "conversations", conversationId));
  if (!conversationSnap.exists()) {
    showToast("Conversation is not available yet. Accept the message request first.", "info");
    return;
  }

  const members = conversationSnap.data().members || [];
  if (!members.includes(currentUser.uid) || members.length !== 2) {
    showToast("You don't have access to this conversation.", "error");
    return;
  }

  const other = members.find((uid) => uid !== currentUser.uid);
  if (!other) return;

  const otherSnap = await getDoc(doc(db, "users", other));
  if (!otherSnap.exists()) return;

  activeConversationId = conversationId;
  activeUser = { uid: other, ...otherSnap.data() };
  ensureUserListener(other);
  refreshChatHeader();

  $id("messageInput").disabled = false;
  $id("attachBtn").disabled = false;
  $id("messageForm").querySelector("button[type=submit]").disabled = false;
  $id("app")?.classList.add("chat-open");

  clearImagePreview();
  renderChatList();
  listenMessages();
  await markRead(activeConversationId);
}

async function markRead(conversationId) {
  if (!conversationId || !currentUser) return;
  try {
    await updateDoc(doc(db, "conversations", conversationId), {
      [`unread.${currentUser.uid}`]: 0
    });
  } catch (error) {
    console.warn("Could not mark conversation read:", error);
  }

  if (currentMessages.length) await markIncomingMessagesRead();
}

async function markIncomingMessagesRead() {
  if (!activeConversationId || !currentUser) return;
  const pending = currentMessages.filter((message) =>
    message.receiverId === currentUser.uid && !message.readBy?.[currentUser.uid] && !isDeletedForUser(message, currentUser.uid)
  );

  for (const message of pending) {
    try {
      await updateDoc(doc(db, "conversations", activeConversationId, "messages", message.id), {
        [`readBy.${currentUser.uid}`]: serverTimestamp()
      });
    } catch (error) {
      console.warn("Could not mark message read:", message.id, error);
    }
  }

  if (getRetentionMode() === "seen" && pending.length) {
    // Cleanup is performed after the read flag has been written and the next snapshot arrives.
    setTimeout(() => {
      cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc).catch(() => {});
    }, 100);
  }
}

function listenMessages() {
  unsubscribeMessages?.();
  cleanupInterval?.();
  currentMessages = [];

  const messagesRef = collection(db, "conversations", activeConversationId, "messages");
  const q = query(messagesRef, orderBy("createdAt"), limit(200));

  unsubscribeMessages = onSnapshot(q, async (snap) => {
    currentMessages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    await cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc);

    const visible = currentMessages.filter((message) => !isDeletedForUser(message, currentUser.uid) && !shouldExpireMessage(message, currentUser.uid));
    const box = $id("messages");
    box.innerHTML = "";

    if (!visible.length) {
      box.innerHTML = `<div class="empty-state"><p>No messages yet.</p><p>Send a message to start the conversation.</p></div>`;
    } else {
      visible.forEach((message) => renderMessage(message));
      box.scrollTop = box.scrollHeight;
    }

    if (document.visibilityState === "visible") {
      await markRead(activeConversationId);
    }
  }, (error) => {
    console.error("Message listener failed:", error);
    $id("messages").innerHTML = `<div class="empty-state">Messages could not be loaded. Check your Firebase rules.</div>`;
  });

  cleanupInterval = startPeriodicCleanup(db, activeConversationId, () => currentMessages, currentUser.uid, updateDoc);
}

function renderMessage(message) {
  const box = $id("messages");
  const el = document.createElement("div");
  const outgoing = message.senderId === currentUser.uid;
  const saved = isSavedByUser(message, currentUser.uid);
  const time = message.createdAt?.toDate ? formatTime(message.createdAt.toDate()) : "";

  el.className = `message ${outgoing ? "outgoing" : ""} ${saved ? "saved" : ""}`;

  if (message.type === "image" && isTrustedImageUrl(message.imageURL)) {
    el.classList.add("image-message");
    const optimized = imageUrl(message.imageURL, "chat");
    el.innerHTML = `
      <img src="${escapeHtml(optimized)}" alt="Shared image" loading="lazy">
      <small>${escapeHtml(time)}${outgoing ? " ✓" : ""}</small>
      ${saved ? '<span class="bookmark-icon">🔖</span>' : ""}
    `;
    el.querySelector("img")?.addEventListener("click", () => openLightbox(message.imageURL));
  } else {
    el.innerHTML = `
      <p>${escapeHtml(message.text || "Attachment unavailable")}</p>
      <small>${escapeHtml(time)}${outgoing ? " ✓" : ""}</small>
      ${saved ? '<span class="bookmark-icon">🔖</span>' : ""}
    `;
  }

  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showMessageActions(el, message, outgoing);
  });

  let holdTimer = null;
  el.addEventListener("touchstart", () => {
    holdTimer = setTimeout(() => showMessageActions(el, message, outgoing), 500);
  }, { passive: true });
  el.addEventListener("touchend", () => clearTimeout(holdTimer));
  el.addEventListener("touchmove", () => clearTimeout(holdTimer));

  box.appendChild(el);

  if (!outgoing && !message._rendered) {
    playReceive();
    message._rendered = true;
  }
}

/* ===================== Message actions ===================== */

function showMessageActions(messageEl, message, isOutgoing) {
  document.querySelectorAll(".message-action-menu").forEach((menu) => menu.remove());

  const menu = document.createElement("div");
  menu.className = "message-action-menu";
  const saved = isSavedByUser(message, currentUser.uid);

  menu.innerHTML = `
    <button class="menu-item save-msg">${saved ? "Unsave" : "Save"}</button>
    ${isOutgoing ? '<button class="menu-item delete-msg">Delete for everyone</button>' : ""}
    <button class="menu-item delete-for-me">Delete for me</button>
  `;
  document.body.appendChild(menu);

  const rect = messageEl.getBoundingClientRect();
  menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 5)}px`;
  menu.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - menu.offsetWidth - 8)}px`;

  menu.querySelector(".save-msg")?.addEventListener("click", async () => {
    playClick();
    await toggleSaveMessage(message.id, saved);
    menu.remove();
  });

  menu.querySelector(".delete-msg")?.addEventListener("click", async () => {
    playClick();
    await deleteMessageForEveryone(message.id);
    menu.remove();
  });

  menu.querySelector(".delete-for-me")?.addEventListener("click", async () => {
    playClick();
    await deleteMessageForMe(message.id, messageEl);
    menu.remove();
  });

  const closeMenu = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

async function toggleSaveMessage(messageId, currentlySaved) {
  if (!activeConversationId || !currentUser) return;
  try {
    const msgRef = doc(db, "conversations", activeConversationId, "messages", messageId);
    const snap = await getDoc(msgRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const savedBy = Array.isArray(data.savedBy) ? [...data.savedBy] : [];

    if (currentlySaved) {
      const updated = savedBy.filter((uid) => uid !== currentUser.uid);
      await updateDoc(msgRef, { savedBy: updated });
      showToast("Message unsaved", "info");
    } else {
      if (!savedBy.includes(currentUser.uid)) savedBy.push(currentUser.uid);
      await updateDoc(msgRef, { savedBy });
      showToast("Message saved 🔖", "success");
    }
  } catch (error) {
    console.error("Error toggling saved message:", error);
    showToast("Failed to update message", "error");
  }
}

async function deleteMessageForEveryone(messageId) {
  if (!activeConversationId || !confirm("Delete this message for everyone?")) return;
  try {
    await deleteDoc(doc(db, "conversations", activeConversationId, "messages", messageId));
    showToast("Message deleted for everyone", "info");
  } catch (error) {
    console.error("Delete for everyone failed:", error);
    showToast("Only the sender can delete this message for everyone.", "error");
  }
}

async function deleteMessageForMe(messageId, messageEl) {
  if (!activeConversationId || !currentUser) return;
  messageEl.classList.add("deleting");
  try {
    const msgRef = doc(db, "conversations", activeConversationId, "messages", messageId);
    const snap = await getDoc(msgRef);
    if (!snap.exists()) return;
    const deletedFor = Array.isArray(snap.data().deletedFor) ? [...snap.data().deletedFor] : [];
    if (!deletedFor.includes(currentUser.uid)) deletedFor.push(currentUser.uid);
    await updateDoc(msgRef, { deletedFor });
    showToast("Message deleted for you", "info");
  } catch (error) {
    console.error("Delete for me failed:", error);
    messageEl.classList.remove("deleting");
    showToast("Failed to delete message for you", "error");
  }
}

/* ===================== Sending text ===================== */

$id("messageForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUser || !activeConversationId) return;
  const messageInput = $id("messageInput");
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  try {
    playSend();
    await sendMessage({ type: "text", text });
    messageInput.focus();
  } catch (error) {
    console.error("Send message failed:", error);
    showToast("Message could not be sent.", "error");
    messageInput.value = text;
  }
});

async function sendMessage({ type, text, imageURL }) {
  if (!activeConversationId || !activeUser || !currentUser) throw new Error("No active conversation");

  const conversationRef = doc(db, "conversations", activeConversationId);
  const conversationSnap = await getDoc(conversationRef);
  if (!conversationSnap.exists()) throw new Error("Conversation does not exist");
  const members = conversationSnap.data().members || [];
  if (!members.includes(currentUser.uid) || !members.includes(activeUser.uid)) {
    throw new Error("Conversation membership mismatch");
  }

  await addDoc(collection(db, "conversations", activeConversationId, "messages"), {
    senderId: currentUser.uid,
    receiverId: activeUser.uid,
    type,
    ...(type === "image" ? { imageURL } : { text: text.slice(0, 5000) }),
    createdAt: serverTimestamp(),
    savedBy: [],
    deletedFor: [],
    readBy: {}
  });

  await updateDoc(conversationRef, {
    lastMessage: type === "image" ? "" : text.slice(0, 500),
    lastMessageType: type,
    lastMessageSenderId: currentUser.uid,
    lastMessageTime: serverTimestamp(),
    [`unread.${activeUser.uid}`]: increment(1)
  });
}

/* ===================== Sending images ===================== */

$id("attachBtn")?.addEventListener("click", () => {
  playClick();
  $id("fileInput")?.click();
});

$id("fileInput")?.addEventListener("change", async () => {
  const file = $id("fileInput").files?.[0];
  $id("fileInput").value = "";
  if (!file) return;

  try {
    await validateImageFile(file);
  } catch (error) {
    showToast(error instanceof UploadError ? error.userMessage : UPLOAD_MESSAGES.invalid, "error");
    return;
  }

  pendingImageFile = file;
  pendingImageUrl = URL.createObjectURL(file);
  $id("imagePreviewThumb").src = pendingImageUrl;
  $id("imagePreviewStatus").textContent = "Ready to send";
  $id("imagePreviewProgress").style.width = "0%";
  $id("imagePreviewBar").hidden = false;
  $id("imagePreviewBar").classList.remove("uploading");
  $id("messageInput").disabled = true;
});

$id("imagePreviewCancel")?.addEventListener("click", () => {
  playClick();
  uploadController?.abort();
  clearImagePreview();
  $id("messageInput").disabled = !activeUser;
});

$id("imagePreviewSend")?.addEventListener("click", async () => {
  if (!pendingImageFile || !activeUser) return;

  playClick();
  const file = pendingImageFile;
  const bar = $id("imagePreviewBar");
  bar.classList.add("uploading");
  $id("imagePreviewSend").disabled = true;
  $id("imagePreviewStatus").textContent = "Uploading…";
  uploadController = new AbortController();

  try {
    const url = await uploadImageToCloudinary(file, {
      signal: uploadController.signal,
      onProgress: (progress) => {
        $id("imagePreviewProgress").style.width = `${Math.round(progress * 100)}%`;
      }
    });
    await sendMessage({ type: "image", imageURL: url });
    playSend();
    showToast("Image sent", "success");
    clearImagePreview();
  } catch (error) {
    if (error?.kind === "aborted") return;
    console.error("Image send failed:", error);
    const message = error instanceof UploadError ? error.userMessage : UPLOAD_MESSAGES.failed;
    $id("imagePreviewStatus").textContent = message;
    bar.classList.remove("uploading");
    $id("imagePreviewSend").disabled = false;
  }
});

function clearImagePreview() {
  if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  pendingImageFile = null;
  pendingImageUrl = null;
  uploadController = null;
  $id("imagePreviewBar").hidden = true;
  $id("imagePreviewBar").classList.remove("uploading");
  $id("imagePreviewSend").disabled = false;
  $id("imagePreviewThumb").src = "";
}

/* ===================== Saved messages ===================== */

async function renderSavedMessages() {
  const box = $id("savedList");
  if (!box || !currentUser) return;
  box.innerHTML = `<div class="empty-state">Loading saved messages…</div>`;

  try {
    const saved = [];
    for (const conversation of conversations) {
      const partnerId = otherUid(conversation);
      const messagesSnap = await getDocs(query(
        collection(db, "conversations", conversation.id, "messages"),
        orderBy("createdAt", "desc"),
        limit(200)
      ));

      const partner = userListeners.get(partnerId)?.data || { uid: partnerId, name: "Conversation" };
      messagesSnap.docs.forEach((d) => {
        const message = { id: d.id, ...d.data(), conversationId: conversation.id };
        if (!isDeletedForUser(message, currentUser.uid) && isSavedByUser(message, currentUser.uid)) {
          saved.push({ message, partner });
        }
      });
    }

    saved.sort((a, b) => (b.message.createdAt?.toMillis?.() ?? 0) - (a.message.createdAt?.toMillis?.() ?? 0));

    if (!saved.length) {
      box.innerHTML = `<div class="empty-state">You have no saved messages.</div>`;
      return;
    }

    box.innerHTML = saved.map(({ message, partner }) => {
      const body = message.type === "image" ? "📷 Photo" : String(message.text || "");
      const when = message.createdAt?.toDate ? formatWhen(message.createdAt.toDate()) : "";
      return `
        <button class="row-item saved-item" data-conversation-id="${escapeHtml(message.conversationId)}" type="button">
          ${avatarHtml(partner, { dot: false })}
          <span class="meta">
            <span class="top-line"><strong>${escapeHtml(partner.name || partner.email || "Conversation")}</strong><span class="time">${escapeHtml(when)}</span></span>
            <span class="preview-line"><span class="text">${escapeHtml(body)}</span></span>
          </span>
          <span aria-hidden="true">🔖</span>
        </button>`;
    }).join("");

    box.querySelectorAll(".saved-item").forEach((button) => {
      button.addEventListener("click", async () => {
        playClick();
        closeModal("savedModal");
        await openChatById(button.dataset.conversationId);
      });
    });
  } catch (error) {
    console.error("Saved messages load failed:", error);
    box.innerHTML = `<div class="empty-state">Saved messages could not be loaded.</div>`;
  }
}

/* ===================== Retention cleanup on app open ===================== */

async function cleanupAllVisibleConversations() {
  if (!currentUser || !conversations.length) return;
  const mode = getRetentionMode();
  if (mode !== "24hours" && mode !== "seen") return;

  // Scan the most recent 200 messages in each conversation. This gives the requested
  // app-open cleanup behavior without requiring a paid server-side scheduler.
  for (const conversation of conversations.slice(0, 50)) {
    try {
      const snap = await getDocs(query(
        collection(db, "conversations", conversation.id, "messages"),
        orderBy("createdAt", "asc"),
        limit(200)
      ));
      const messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      await cleanupExpiredMessages(db, conversation.id, messages, currentUser.uid, updateDoc);
    } catch (error) {
      console.warn("Conversation retention scan failed:", conversation.id, error);
    }
  }
}

// Keep the search minimum visible in source for maintainability.
void SEARCH_MIN_LENGTH;
