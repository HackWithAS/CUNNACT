import {
  auth, db, onAuthStateChanged, signOut, sendEmailVerification, reload,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection,
  query, where, orderBy, startAt, endAt, limit, onSnapshot,
  serverTimestamp, increment, writeBatch, runTransaction, arrayUnion, arrayRemove
} from "./firebase.js";
import { uploadImageToCloudinary, validateImageFile, UploadError, MESSAGES as UPLOAD_MESSAGES, isTrustedImageUrl, imageUrl } from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { formatTime, formatWhen, formatLastSeen, escapeHtml, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { normalizeSearch, isSearchValid } from "./users.js";
import { listenMessageRequests, sendMessageRequest, acceptMessageRequest, declineMessageRequest } from "./requests.js";
import { playClick, playSend, playReceive, playSave, playDelete, isSoundEnabled, toggleSound } from "./sound.js";
import { loadRetentionMode, getRetentionMode, shouldExpireMessage, cleanupExpiredMessages, startPeriodicCleanup, isSavedByUser, isDeletedForUser, setUserSetting } from "./retention.js";

let currentUser = null;
let currentUserData = {};
let currentBlockedUsers = new Set();
let activeUser = null;
let activeConversationId = null;
let activeConversation = null;
let activeGroupMembers = new Map();
let unsubscribeMessages = null;
let unsubscribeTyping = null;
let unsubscribeConversations = null;
let cleanupInterval = null;
let presenceHeartbeat = null;
let presenceUiTimer = null;
let conversations = [];
let chatSearchTerm = "";
let currentMessages = [];
let activeMessageMap = new Map();
let userListeners = new Map();
let lastMessageCount = 0;
let pendingImageFile = null;
let pendingImageUrl = null;
let uploadController = null;
let sendingMessage = false;
let staticBound = false;
let messageListenerToken = 0;
let confirmDialogResolver = null;
let replyTarget = null;
let readObserver = null;
let queuedReadIds = new Set();
let readFlushTimer = null;
let deliveredFlushTimer = null;
const queuedDeliveredIds = new Set();
let ownHeartbeatAt = 0;
const localHiddenLatest = new Set();
const ONLINE_WINDOW_MS = 90 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

const $id = (id) => document.getElementById(id);
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="m7 7 10 10"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M7 10V7a5 5 0 0 1 9.7-1.6"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>'
};

function timestampDate(value) {
  return value?.toDate?.() || (value instanceof Date ? value : null);
}
function isUserOnline(user) {
  const heartbeat = timestampDate(user?.lastHeartbeat);
  if (!heartbeat) return false;
  const age = Date.now() - heartbeat.getTime();
  return age >= -5000 && age <= ONLINE_WINDOW_MS && user?.isOnline !== false;
}
function setStatusDot(el, online) { el?.classList.toggle("online", !!online); }
function ownPresencePayload(online) {
  return online ? { isOnline: true, lastHeartbeat: serverTimestamp() } : { isOnline: false, lastSeen: serverTimestamp() };
}
async function setOwnPresence(online) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), ownPresencePayload(online));
    if (online) {
      ownHeartbeatAt = Date.now();
      currentUserData = { ...currentUserData, isOnline: true, lastHeartbeat: new Date(ownHeartbeatAt) };
    } else {
      currentUserData = { ...currentUserData, isOnline: false, lastSeen: new Date() };
    }
    refreshPresenceUI();
  } catch (e) { console.warn("Presence update failed", e); }
}
function refreshPresenceUI() {
  const ownOnline = document.visibilityState === "visible" && ownHeartbeatAt > 0 && (Date.now() - ownHeartbeatAt) <= ONLINE_WINDOW_MS;
  const ownStatus = $id("currentUserStatus");
  if (ownStatus) ownStatus.textContent = ownOnline ? "Online" : "Offline";
  setStatusDot($id("currentUserAvatar")?.querySelector(".status-dot"), ownOnline);
  renderChatList();
  refreshChatHeader();
}
function startPresence() {
  clearInterval(presenceHeartbeat);
  clearInterval(presenceUiTimer);
  ownHeartbeatAt = Date.now();
  setOwnPresence(true);
  presenceHeartbeat = setInterval(() => {
    if (document.visibilityState === "visible" && navigator.onLine !== false) setOwnPresence(true);
  }, 30000);
  presenceUiTimer = setInterval(refreshPresenceUI, 15000);
}

function openModal(id) {
  const modal = $id(id); if (!modal) return;
  document.querySelectorAll(".dropdown-menu:not([hidden])").forEach((m) => m.hidden = true);
  modal.hidden = false; modal.setAttribute("aria-hidden", "false"); document.body.classList.add("modal-open");
}
function closeModal(id) {
  const modal = $id(id); if (!modal) return;
  modal.hidden = true; modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
}
function showConfirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $id("confirmModal"); if (!modal) return resolve(false);
    confirmDialogResolver = resolve;
    $id("confirmTitle").textContent = title || "Are you sure?";
    $id("confirmMessage").textContent = message || "This action cannot be undone.";
    const confirmBtn = $id("confirmActionBtn");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("danger-confirm", danger);
    openModal("confirmModal");
    setTimeout(() => confirmBtn.focus(), 20);
  });
}
function finishConfirmDialog(result) {
  const resolve = confirmDialogResolver; confirmDialogResolver = null;
  closeModal("confirmModal"); resolve?.(!!result);
}
let systemThemeMedia = null;
function resolveTheme(pref) {
  if (pref === "dark") return "dark";
  if (pref === "system") return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  return "light";
}
function watchSystemTheme(enable) {
  if (!window.matchMedia) return;
  if (!systemThemeMedia) systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeMedia.onchange = enable ? () => applyTheme("system", false) : null;
}
function applyTheme(theme, persist = true) {
  const pref = (theme === "dark" || theme === "system") ? theme : "light";
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("cunnact_theme", pref);
  $id("themeToggleLabel") && ($id("themeToggleLabel").textContent = resolved === "dark" ? "Light mode" : "Dark mode");
  document.querySelectorAll('input[name="themeMode"]').forEach(r => { r.checked = (r.value === pref); });
  watchSystemTheme(pref === "system");
  if (persist && currentUser) setUserSetting(currentUser.uid, { theme: pref }).catch(() => {});
}
function updateSoundToggle() {
  const btn = $id("soundToggle"); if (!btn) return;
  btn.innerHTML = isSoundEnabled()
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 9v6h4l5 4V5L9 9H5Z"/><path d="M17 9.5a4 4 0 0 1 0 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m5 9 4 6h4l5 4V5l-5 4H9L5 3"/></svg>';
  btn.title = isSoundEnabled() ? "Sound on" : "Sound off";
  btn.setAttribute("aria-label", btn.title);
}
function toggleDropdown(id, buttonId) {
  const menu = $id(id), button = $id(buttonId); if (!menu) return;
  const nextOpen = menu.hidden;
  document.querySelectorAll(".dropdown-menu").forEach((m) => { if (m !== menu) m.hidden = true; });
  menu.hidden = !nextOpen; button?.setAttribute("aria-expanded", String(nextOpen));
}

/* Auth bootstrap */
applyTheme(localStorage.getItem("cunnact_theme") || "light", false);
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("login.html"); return; }
  if (!user.emailVerified) { currentUser = user; showVerifyGate(user); return; }
  currentUser = user;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    currentUserData = snap.exists() ? snap.data() : {};
    const settingsSnap = await getDoc(doc(db, "userSettings", user.uid)).catch(() => null);
    const accountSettings = settingsSnap?.exists?.() ? settingsSnap.data() : {};
    const theme = accountSettings.theme || localStorage.getItem("cunnact_theme") || "light";
    applyTheme(theme, false);
    if (typeof accountSettings.soundEnabled === "boolean") {
      const { setSoundEnabled } = await import("./sound.js");
      setSoundEnabled(accountSettings.soundEnabled);
    }
    await setDoc(ref, {
      uid: user.uid,
      name: currentUserData.name || user.displayName || user.email || "User",
      email: currentUserData.email || user.email || "",
      emailLower: String(currentUserData.email || user.email || "").toLowerCase(),
      photoURL: currentUserData.photoURL || user.photoURL || "",
      bio: currentUserData.bio || "",
      username: currentUserData.username || "",
      usernameLower: currentUserData.usernameLower || "",
      retentionMode: currentUserData.retentionMode || "24hours",
      theme,
      isOnline: true,
      lastHeartbeat: serverTimestamp()
    }, { merge: true });
    currentUserData = { ...currentUserData, isOnline: true, lastHeartbeat: new Date() };
    await ensurePublicProfile();
    await loadRetentionMode(user.uid);
    await loadBlockedUsers();
    hydrateCurrentUserUI();
    bindStaticControls();
    startPresence();
    listenMessageRequests(currentUser, (requests) => { updateRequestsBadge(requests.length); renderMessageRequests(requests); });
    listenConversations();
    const newChatUsername = new URLSearchParams(location.search).get("newChat");
    if (newChatUsername) setTimeout(() => openNewChatWithQuery(newChatUsername), 120);
    const gate = $id("authGate"); if (gate) gate.hidden = true;
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
function showVerifyGate(user){
  const gate=$id("authGate"); if(!gate) return;
  gate.hidden=false;
  gate.innerHTML=`<div class="auth-gate-card">
    <strong>Verify your email</strong>
    <span>We sent a confirmation link to ${escapeHtml(user.email||"your email")}.</span>
    <span class="verify-spam-note">Don't see it? Check your <strong>Spam / Promotions</strong> folder — verification emails sometimes land there.</span>
    <button id="resendVerifyBtn" class="btn btn-primary">Resend email</button>
    <button id="checkVerifyBtn" class="btn btn-soft">I've verified — continue</button>
    <button id="verifyLogoutBtn" class="btn btn-soft danger-item">Log out</button>
  </div>`;
  let cooldown=false;
  $id("resendVerifyBtn")?.addEventListener("click", async ()=>{
    if(cooldown){ showToast("Please wait a minute before resending.","info"); return; }
    try{
      await sendEmailVerification(user);
      cooldown=true; setTimeout(()=>{cooldown=false;},60000);
      showToast("Verification email sent — check Spam/Promotions too.","success");
    }catch(e){
      console.error("Resend verification failed",e);
      showToast(e?.code==="auth/too-many-requests"?"Too many attempts. Wait a few minutes.":"Could not send email. Try again shortly.","error");
    }
  });
  $id("checkVerifyBtn")?.addEventListener("click", async ()=>{
    try{ await reload(user); if(user.emailVerified){ location.reload(); } else { showToast("Still not verified. Check Spam/Promotions, or resend the link.","info"); } }
    catch(e){ showToast("Could not refresh status.","error"); }
  });
  $id("verifyLogoutBtn")?.addEventListener("click", ()=> signOut(auth));
}
async function ensurePublicProfile() {
  if (!currentUser) return;
  const data = currentUserData || {};
  if (!data.username) return;
  await setDoc(doc(db, "publicProfiles", currentUser.uid), {
    uid: currentUser.uid, username: data.username, usernameLower: data.usernameLower || data.username,
    displayName: data.name || currentUser.displayName || currentUser.email || "CUNNACT user",
    photoURL: data.photoURL || currentUser.photoURL || "", bio: data.bio || "", updatedAt: serverTimestamp()
  }, { merge: true }).catch(() => {});
}
function hydrateCurrentUserUI() {
  const name = currentUserData.name || currentUser.displayName || currentUser.email || "User";
  const email = currentUserData.email || currentUser.email || "";
  $id("currentUserName") && ($id("currentUserName").textContent = name);
  $id("currentUserEmail") && ($id("currentUserEmail").textContent = email);
  paintAvatar($id("currentUserAvatar"), { photoURL: currentUserData.photoURL || currentUser.photoURL || "", name, email });
  paintAvatar($id("menuUserAvatar"), { photoURL: currentUserData.photoURL || currentUser.photoURL || "", name, email, preset: "avatarSm" });
  $id("menuUserName") && ($id("menuUserName").textContent = name);
  $id("menuUserEmail") && ($id("menuUserEmail").textContent = email);
}

/* Lifecycle */
document.addEventListener("visibilitychange", () => {
  if (!currentUser) return;
  setOwnPresence(document.visibilityState === "visible");
  if (document.visibilityState === "visible") {
    flushQueuedReads();
    refreshPresenceUI();
    if (activeConversationId) cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc).catch(() => {});
  }
});
window.addEventListener("pagehide", () => { clearInterval(presenceHeartbeat); clearInterval(presenceUiTimer); setOwnPresence(false); });
window.addEventListener("beforeunload", () => { if (currentUser) setOwnPresence(false); });
window.addEventListener("online", () => { if (currentUser && document.visibilityState === "visible") setOwnPresence(true); });
window.addEventListener("offline", () => { if (currentUser) { currentUserData = { ...currentUserData, isOnline:false }; refreshPresenceUI(); } });

/* Static controls */
function bindStaticControls() {
  if (staticBound) return; staticBound = true;
  updateSoundToggle();
  $id("logoutBtn")?.addEventListener("click", logout);
  $id("themeToggleBtn")?.addEventListener("click", () => { playClick(); applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
  $id("navThemeBtn")?.addEventListener("click", () => { playClick(); applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
  $id("profileBtn")?.addEventListener("click", () => { playClick(); location.href = "profile.html"; });
  $id("accountMenuBtn")?.addEventListener("click", (e) => { e.stopPropagation(); playClick(); toggleDropdown("accountMenu", "accountMenuBtn"); });
  $id("soundToggle")?.addEventListener("click", () => { const enabled = toggleSound(); updateSoundToggle(); if (currentUser) setUserSetting(currentUser.uid,{soundEnabled:enabled}).catch(()=>{}); if (enabled) playClick(); });
  $id("backBtn")?.addEventListener("click", () => { playClick(); $id("app")?.classList.remove("chat-open"); closeProfileDrawer(); });
  $id("chatAvatar")?.addEventListener("click", () => { if (activeUser?.uid === currentUser?.uid) return; activeUser?.username ? location.href = `/u/${encodeURIComponent(activeUser.username)}` : openProfileDrawer(); });
  $id("chatMoreBtn")?.addEventListener("click", (e) => { e.stopPropagation(); if (!activeUser) return; playClick(); renderChatMoreMenu(); toggleDropdown("chatMoreMenu", "chatMoreBtn"); });
  const newChat = () => { playClick(); openModal("newChatModal"); $id("newChatSearch").value=""; $id("newChatResults").innerHTML='<div class="empty-state">Search by @CUNNACT ID or email.</div>'; requestAnimationFrame(()=> $id("newChatSearch")?.focus()); };
  // Desktop (>820px): "New chat" opens a 2-item menu (Message someone / Create
  // group) instead of jumping straight into the new-chat modal. Mobile is
  // untouched -- below 821px this menu is hidden by CSS and newChatBtn falls
  // through to the original newChat() call, exactly like before.
  const isDesktopWidth = () => window.matchMedia("(min-width: 821px)").matches;
  const closeNewChatMenu = () => { const m=$id("newChatMenu"); if(m){m.hidden=true;} $id("newChatBtn")?.setAttribute("aria-expanded","false"); };
  $id("newChatBtn")?.addEventListener("click", (e) => {
    if (!isDesktopWidth()) { newChat(); return; }
    e.stopPropagation();
    const menu = $id("newChatMenu");
    if (!menu) { newChat(); return; }
    const btn = $id("newChatBtn");
    const opening = menu.hidden;
    document.querySelectorAll(".dropdown-menu").forEach(m => { if (m !== menu) m.hidden = true; });
    menu.hidden = !opening;
    btn?.setAttribute("aria-expanded", String(opening));
    if (opening) {
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${r.left}px`;
    }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#newChatMenu, #newChatBtn")) closeNewChatMenu(); });
  $id("newChatMenuMessage")?.addEventListener("click", () => { closeNewChatMenu(); newChat(); });
  $id("newChatMenuGroup")?.addEventListener("click", () => { closeNewChatMenu(); playClick(); openNewGroupModal(); });
  $id("navNewChatBtn")?.addEventListener("click", newChat);
  $id("newGroupBtn")?.addEventListener("click", () => { playClick(); openNewGroupModal(); });
  $id("createGroupBtn")?.addEventListener("click", createGroup);
  $id("addGroupMembersBtn")?.addEventListener("click", addGroupMembers);
  $id("leaveGroupBtn")?.addEventListener("click", leaveGroupChat);
  $id("requestsBtn")?.addEventListener("click", () => { playClick(); openModal("requestsModal"); });
  $id("navRequestsBtn")?.addEventListener("click", () => { playClick(); openModal("requestsModal"); });
  $id("savedBtn")?.addEventListener("click", async () => { playClick(); openModal("savedModal"); await renderSavedMessages(); });
  $id("navSavedBtn")?.addEventListener("click", async () => { playClick(); openModal("savedModal"); await renderSavedMessages(); });
  $id("navChatsBtn")?.addEventListener("click", () => { playClick(); $id("app")?.classList.remove("chat-open"); });
  $id("userSearch")?.addEventListener("input", debounce((e) => { chatSearchTerm = normalizeSearch(e.target.value); renderChatList(); }, 120));
  $id("newChatSearch")?.addEventListener("input", debounce((e) => loadNewChatSearch(e.target.value), 320));
  $id("messageForm")?.addEventListener("submit", handleMessageSubmit);
  $id("messageInput")?.addEventListener("input", () => { autoGrowComposer(); handleTypingInput(); });
  $id("messageInput")?.addEventListener("blur", stopTyping);
  $id("attachBtn")?.addEventListener("click", () => { playClick(); $id("fileInput")?.click(); });
  $id("fileInput")?.addEventListener("change", handleImageSelection);
  $id("imagePreviewCancel")?.addEventListener("click", cancelImagePreview);
  $id("imagePreviewSend")?.addEventListener("click", sendPendingImage);
  $id("cancelReplyBtn")?.addEventListener("click", clearReply);
  $id("closeProfileDrawer")?.addEventListener("click", closeProfileDrawer);
  $id("drawerViewProfile")?.addEventListener("click", () => { if (activeUser?.uid === currentUser?.uid) return; if (activeUser?.username) location.href=`/u/${encodeURIComponent(activeUser.username)}`; });
  document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => { playClick(); closeModal(button.closest(".modal")?.id); }));
  document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (e) => { if (e.target === modal) modal.id === "confirmModal" ? finishConfirmDialog(false) : closeModal(modal.id); }));
  $id("confirmActionBtn")?.addEventListener("click", () => { playClick(); finishConfirmDialog(true); });
  $id("confirmCancelBtn")?.addEventListener("click", () => { playClick(); finishConfirmDialog(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$id("confirmModal")?.hidden) finishConfirmDialog(false);
      else document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id));
      closeMessageActionMenus(); closeProfileDrawer();
    }
    if (e.key === "Enter" && !e.shiftKey && document.activeElement === $id("messageInput")) { e.preventDefault(); $id("messageForm")?.requestSubmit(); }
  });
  document.addEventListener("click", (e) => {
    ["accountMenu", "chatMoreMenu"].forEach((id) => { const m=$id(id); if (!m || m.hidden) return; if (!m.parentElement?.contains(e.target)) { m.hidden=true; } });
    if (!e.target.closest(".message-action-menu") && !e.target.closest(".message-more")) closeMessageActionMenus();
  });
  $id("messages")?.addEventListener("scroll", () => { if ($id("messages").scrollTop < 80) $id("messages").classList.add("near-top"); else $id("messages").classList.remove("near-top"); });
}
async function logout() {
  try { await setOwnPresence(false); await signOut(auth); } catch (e) { console.error(e); showToast("Could not log out.", "error"); }
}

/* Requests */
function updateRequestsBadge(count) {
  [$id("requestsBadge"), $id("navRequestsBadge")].forEach((badge) => {
    if (!badge) return;
    badge.textContent=count>99?"99+":String(count);
    badge.hidden=count<=0;
  });
}
function renderMessageRequests(requests) {
  const container=$id("requestsList"); if(!container) return;
  if(!requests.length){container.innerHTML='<div class="empty-state">No new requests.<br><span>New connection requests will appear here.</span></div>';return;}
  container.innerHTML=requests.map(req=>`<div class="request-item" data-request-id="${escapeHtml(req.id)}">${avatarHtml({name:req.senderName,email:req.senderEmail},{dot:false})}<div class="meta"><strong>${escapeHtml(req.senderName||req.senderUsername||"User")}</strong>${req.senderUsername?`<span class="email">@${escapeHtml(req.senderUsername)}</span>`:""}<span class="subtitle">Wants to start a conversation</span></div><div class="actions"><button class="btn btn-sm btn-primary accept-request" type="button">Accept</button><button class="btn btn-sm btn-soft decline-request" type="button">Decline</button></div></div>`).join("");
  requests.forEach((req,index)=>{const row=container.querySelectorAll(".request-item")[index];paintAvatar(row?.querySelector(".avatar"),{photoURL:req.senderPhotoURL||"",name:req.senderName,email:req.senderEmail});});
  container.querySelectorAll(".request-item").forEach(row=>{
    const req=requests.find(r=>r.id===row.dataset.requestId); if(!req)return;
    row.querySelector(".accept-request")?.addEventListener("click",async()=>{const btn=row.querySelector(".accept-request");btn.disabled=true;btn.textContent="Accepting…";const id=await acceptMessageRequest(req.id,req,currentUser);if(id){closeModal("requestsModal");await openChatById(id,req.senderId);}else{btn.disabled=false;btn.textContent="Accept";}});
    row.querySelector(".decline-request")?.addEventListener("click",async()=>{const btn=row.querySelector(".decline-request");btn.disabled=true;btn.textContent="Declining…";const ok=await declineMessageRequest(req.id);if(!ok){btn.disabled=false;btn.textContent="Decline";}});
  });
}

/* Search */
function matchesChat(user, term){if(!term)return true;const n=String(user?.name||"").toLowerCase(),e=String(user?.email||"").toLowerCase(),u=String(user?.username||"").toLowerCase();return n.includes(term)||e.includes(term)||u.includes(term);}
async function loadNewChatSearch(value){
  const box=$id("newChatResults"); if(!box)return;
  const raw=String(value||"").trim();
  if(!raw){box.innerHTML='<div class="empty-state">Search by @CUNNACT ID or email.</div>';return;}
  const username=raw.replace(/^@/i,"").toLowerCase();
  if((raw.startsWith("@") || (!raw.includes("@") && USERNAME_PATTERN.test(username))) && username.length>=3){
    box.innerHTML='<div class="empty-state">Searching CUNNACT ID…</div>';
    try{const map=await getDoc(doc(db,"usernames",username));if(!map.exists()){box.innerHTML='<div class="empty-state">No CUNNACT account found.</div>';return;}const uid=map.data()?.uid;if(!uid||uid===currentUser.uid){box.innerHTML='<div class="empty-state">No other account found.</div>';return;}const snap=await getDoc(doc(db,"publicProfiles",uid));if(!snap.exists()){box.innerHTML='<div class="empty-state">Public profile is unavailable.</div>';return;}const profile=snap.data();renderNewChatResults([{uid,...profile,email:""}],box);}catch(e){console.error(e);box.innerHTML='<div class="empty-state">Could not search right now.</div>';}return;
  }
  if(!isSearchValid(raw)){box.innerHTML='<div class="empty-state">Enter at least 6 characters of an email address, or use @username.</div>';return;}
  box.innerHTML='<div class="empty-state">Searching email…</div>';
  try{const term=raw.toLowerCase();const snap=await getDocs(query(collection(db,"users"),orderBy("emailLower"),startAt(term),endAt(`${term}\uf8ff`),limit(20)));renderNewChatResults(snap.docs.map(d=>({uid:d.id,...d.data()})).filter(u=>u.uid!==currentUser.uid),box);}catch(e){console.error(e);box.innerHTML=`<div class="empty-state">Search unavailable.<br><span>${escapeHtml(e?.code||"Try again")}</span></div>`;}
}
function renderNewChatResults(matches,box){
  if(!matches.length){box.innerHTML='<div class="empty-state">No CUNNACT account found.</div>';return;}
  box.innerHTML=matches.map(user=>{const connected=conversations.some(c=>c.members?.includes(user.uid));const blocked=currentBlockedUsers.has(user.uid);let label=blocked?"Blocked":connected?"Open chat":"Send request";return `<div class="new-person-row" data-uid="${escapeHtml(user.uid)}">${avatarHtml(user,{dot:false})}<div class="meta"><strong>${escapeHtml(user.name||user.displayName||"User")}</strong><span>@${escapeHtml(user.username||"")}</span></div><button class="btn ${blocked?"btn-soft":"btn-primary"} btn-sm new-chat-action" ${blocked?"disabled":""}>${label}</button></div>`;}).join("");
  box.querySelectorAll(".new-person-row").forEach((row,index)=>{const user=matches[index];paintAvatar(row.querySelector(".avatar"),user);row.querySelector(".new-chat-action")?.addEventListener("click",async()=>{const btn=row.querySelector(".new-chat-action");if(btn.disabled)return;if(conversations.some(c=>c.members?.includes(user.uid))){const c=conversations.find(c=>c.members?.includes(user.uid));closeModal("newChatModal");return openChatById(c.id,user.uid);}btn.disabled=true;btn.textContent="Sending…";const senderProfile={uid:currentUser.uid,email:currentUser.email,displayName:currentUserData.name||currentUser.displayName,photoURL:currentUserData.photoURL||currentUser.photoURL||"",username:currentUserData.username||""};const result=await sendMessageRequest(senderProfile,user.uid,user);if(result?.alreadyExists){closeModal("newChatModal");await openChatById(result.conversationId);}else if(result?.pending){btn.disabled=true;btn.textContent="Request sent ✓";}else if(result?.incomingPending){btn.disabled=false;btn.textContent="Check requests";}else if(result){btn.disabled=true;btn.textContent="Request sent ✓";setTimeout(()=>closeModal("newChatModal"),550);}else{btn.disabled=false;btn.textContent="Send request";}});});
}
function openNewChatWithQuery(value){openModal("newChatModal");const input=$id("newChatSearch");if(input){input.value=value.startsWith("@")?value:`@${value}`;loadNewChatSearch(input.value);setTimeout(()=>input.focus(),20);}history.replaceState({},"",location.pathname);}

/* Conversations */
function listenConversations(){
  unsubscribeConversations?.();
  const q=query(collection(db,"conversations"),where("members","array-contains",currentUser.uid),limit(100));
  unsubscribeConversations=onSnapshot(q,(snap)=>{
    conversations=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.lastMessageTime?.toMillis?.()??b.createdAt?.toMillis?.()??0)-(a.lastMessageTime?.toMillis?.()??a.createdAt?.toMillis?.()??0));
    const activeUids=new Set(conversations.map(otherUid).filter(Boolean));
    for(const [uid,entry] of userListeners){ if(!activeUids.has(uid) && uid!==activeUser?.uid){ entry.unsub?.(); userListeners.delete(uid); } }
    conversations.forEach(c=>ensureUserListener(otherUid(c)));
    renderChatList();
  },e=>{console.error(e);$id("chatList").innerHTML='<div class="empty-state">Chats could not be loaded.<br><span>Check your Firebase connection and rules.</span></div>';});
}
function otherUid(c){return Array.isArray(c.members)?c.members.find(uid=>uid!==currentUser.uid):null;}
function ensureUserListener(uid){if(!uid||userListeners.has(uid))return;const entry={data:null,unsub:null};entry.unsub=onSnapshot(doc(db,"users",uid),snap=>{entry.data=snap.exists()?{uid,...snap.data()}:{uid};renderChatList();if(activeUser?.uid===uid){activeUser={...activeUser,...entry.data};refreshChatHeader();renderProfileDrawer();}},e=>console.warn("User listener failed",uid,e));userListeners.set(uid,entry);}
function conversationDisplay(c){
  if(c.type==="group")return{uid:null,isGroup:true,name:c.groupName||"Group",photoURL:c.groupPhotoURL||"",memberCount:(c.members||[]).length};
  const uid=otherUid(c);return userListeners.get(uid)?.data||{uid,name:"Conversation"};
}
function renderChatList(){
  const box=$id("chatList");if(!box||!currentUser)return;
  const visible=conversations.filter(c=>!c.hiddenFor?.[currentUser.uid]);
  const filtered=visible.filter(c=>matchesChat(conversationDisplay(c),chatSearchTerm))
    .sort((a,b)=>{const pa=a.pinned?.[currentUser.uid]?1:0,pb=b.pinned?.[currentUser.uid]?1:0;if(pa!==pb)return pb-pa;return(b.lastMessageTime?.toMillis?.()??b.createdAt?.toMillis?.()??0)-(a.lastMessageTime?.toMillis?.()??a.createdAt?.toMillis?.()??0);});
  if(!filtered.length){box.innerHTML=chatSearchTerm?`<div class="empty-state">No conversations match “${escapeHtml(chatSearchTerm)}”.</div>`:'<div class="empty-state big">Your inbox is quiet.<br><span>Start a new chat to connect.</span></div>';return;}
  box.innerHTML=filtered.map(c=>{const isGroup=c.type==="group";const uid=isGroup?null:otherUid(c);const user=conversationDisplay(c),unread=Number(c.unread?.[currentUser.uid]||0),when=c.lastMessageTime?.toDate?.()||c.createdAt?.toDate?.(),blocked=!isGroup&&currentBlockedUsers.has(uid),pinned=!!c.pinned?.[currentUser.uid];let preview=c.lastMessage?previewText({type:c.lastMessageType,text:c.lastMessage},{isMine:c.lastMessageSenderId===currentUser.uid}):"No messages yet";if(isGroup&&c.lastMessage&&c.lastMessageSenderId&&c.lastMessageSenderId!==currentUser.uid){const senderName=(userListeners.get(c.lastMessageSenderId)?.data?.name||"").split(" ")[0];if(senderName)preview=`${senderName}: ${preview}`;}if(localHiddenLatest.has(c.id))preview="Message hidden for you";return `<button class="chat-item ${activeConversationId===c.id?"active":""} ${pinned?"is-pinned":""}" data-conversation-id="${escapeHtml(c.id)}" type="button">${avatarHtml(user,{dot:!isGroup})}${isGroup?`<span class="group-badge">${ICONS.profile}</span>`:""}<span class="meta"><span class="top-line"><strong>${escapeHtml(user.name||"User")}</strong>${pinned?`<span class="pin-indicator" title="Pinned">${ICONS.bookmark}</span>`:""}<span class="time">${escapeHtml(when?formatWhen(when):"")}</span></span><span class="preview-line"><span class="text">${escapeHtml(blocked?"Blocked":preview)}</span>${unread>0&&!blocked?`<span class="unread-badge">${unread>99?"99+":unread}</span>`:""}</span></span></button>`;}).join("");
  filtered.forEach(c=>{const isGroup=c.type==="group";const uid=isGroup?null:otherUid(c);const user=conversationDisplay(c),row=box.querySelector(`[data-conversation-id="${CSS.escape(c.id)}"]`);paintAvatar(row?.querySelector(".avatar"),user);if(!isGroup)setStatusDot(row?.querySelector(".status-dot"),isUserOnline(user));});
  box.querySelectorAll(".chat-item").forEach(row=>{
    let pressTimer=null,longPressed=false;
    row.addEventListener("click",()=>{if(longPressed){longPressed=false;return;}const c=conversations.find(x=>x.id===row.dataset.conversationId);if(!c)return;playClick();openChatById(c.id); });
    row.addEventListener("contextmenu",(e)=>{e.preventDefault();showChatItemContextMenu(row.dataset.conversationId,row,e.clientX,e.clientY);});
    row.addEventListener("touchstart",()=>{longPressed=false;pressTimer=setTimeout(()=>{longPressed=true;if(navigator.vibrate)navigator.vibrate(12);const r=row.getBoundingClientRect();showChatItemContextMenu(row.dataset.conversationId,row,r.left+20,r.top+20);},480);},{passive:true});
    row.addEventListener("touchend",()=>{clearTimeout(pressTimer);});
    row.addEventListener("touchmove",()=>{clearTimeout(pressTimer);});
  });
}

/* Active chat */
async function openChatById(conversationId,hintedUid=null){
  if(!currentUser||!conversationId)return;
  try{
    const snap=await getDoc(doc(db,"conversations",conversationId));if(!snap.exists()){showToast("Conversation is not available yet.","info");return;}
    const data=snap.data(),members=data.members||[];if(!members.includes(currentUser.uid)){showToast("You don't have access to this conversation.","error");return;}
    closeMessageActionMenus();stopTyping();unsubscribeTyping?.();unsubscribeTyping=null;unsubscribeMessages?.();unsubscribeMessages=null;cleanupInterval?.();cleanupInterval=null;
    activeConversationId=conversationId;activeConversation={id:conversationId,...data};

    if(data.type==="group"){
      const profiles=await Promise.all(members.map(async uid=>{
        if(uid===currentUser.uid)return[uid,{uid,name:currentUserData.name||"You",photoURL:currentUserData.photoURL||""}];
        const cached=userListeners.get(uid)?.data;
        if(cached)return[uid,cached];
        try{const s=await getDoc(doc(db,"users",uid));return[uid,s.exists()?{uid,...s.data()}:{uid,name:"Member"}];}catch{return[uid,{uid,name:"Member"}];}
      }));
      activeGroupMembers=new Map(profiles);
      members.forEach(uid=>{if(uid!==currentUser.uid)ensureUserListener(uid);});
      activeUser={uid:null,isGroup:true,name:data.groupName||"Group",photoURL:data.groupPhotoURL||"",memberCount:members.length,members,admins:data.groupAdmins||[]};
    }else{
      const other=members.find(uid=>uid!==currentUser.uid)||hintedUid;if(!other)return;
      const user=userListeners.get(other)?.data||(await getDoc(doc(db,"users",other))).data();if(!user){showToast("User profile not found.","error");return;}
      activeGroupMembers=new Map();
      activeUser={uid:other,isGroup:false,...user};
      ensureUserListener(other);
    }

    $id("app")?.classList.add("chat-open");clearImagePreview();clearReply();$id("chatMoreBtn").disabled=false;$id("chatMoreBtn")?.setAttribute("aria-hidden","false");refreshChatHeader();setComposerState();renderProfileDrawer();renderChatList();
    await updateDoc(doc(db,"conversations",conversationId),{[`unread.${currentUser.uid}`]:0}).catch(()=>{});
    listenMessages();listenTyping();
  }catch(e){console.error("Open chat failed",e);showToast(e?.code==="permission-denied"?"You don't have access to this chat.":"Could not open this chat.","error");}
}
function refreshChatHeader(){
  if(!activeUser)return;
  if(activeUser.isGroup){
    $id("chatName").textContent=activeUser.name||"Group";
    const typingCount=0; // set by listenTyping via #chatTyping directly
    $id("chatStatus").textContent=`${activeUser.memberCount||activeUser.members?.length||0} members`;
    $id("chatStatusPill").hidden=true;
    setStatusDot($id("chatStatusDot"),false);
    paintAvatar($id("chatAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name});
    setComposerState();
    return;
  }
  const live=userListeners.get(activeUser.uid)?.data;if(live)activeUser={...activeUser,...live};const online=isUserOnline(activeUser),blocked=currentBlockedUsers.has(activeUser.uid);$id("chatName").textContent=activeUser.name||(activeUser.username?`@${activeUser.username}`:"User");
  // Last seen is mutual: if either side has turned it off, neither can see the other's last-seen time.
  const canSeeLastSeen=!currentUserData.hideLastSeen&&!activeUser.hideLastSeen;
  const status=blocked?"Blocked by you":online?"Active now":(canSeeLastSeen?`Offline · ${formatLastSeen(activeUser.lastSeen?.toDate?.()||null)}`:"Offline");$id("chatStatus").textContent=status;$id("chatStatusPill").hidden=!online||blocked;if(!$id("chatStatusPill").hidden)$id("chatStatusPill").textContent="Online";setStatusDot($id("chatStatusDot"),online&&!blocked);paintAvatar($id("chatAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name,email:activeUser.email});setComposerState();}
function isBlockedByEither(){return !!(activeUser&&currentBlockedUsers.has(activeUser.uid));}
function setComposerState(){const blocked=isBlockedByEither(),enabled=!!activeUser&&!!activeConversationId&&!blocked&&!sendingMessage;$id("messageInput").disabled=!enabled;$id("attachBtn").disabled=!enabled;$id("messageForm").querySelector("button[type=submit]").disabled=!enabled;$id("messageInput").placeholder=blocked?"Messaging is blocked":"Write a message…";const notice=$id("blockedNotice");if(blocked){notice.hidden=false;notice.innerHTML=`<span>${ICONS.block}</span><span>You blocked this person. Unblock them to continue.</span>`;}else notice.hidden=true;}
function renderChatMoreMenu(){
  const menu=$id("chatMoreMenu");if(!menu||!activeUser)return;
  if(activeUser.isGroup){
    const isAdmin=(activeUser.admins||[]).includes(currentUser.uid);
    menu.innerHTML=`<div class="dropdown-label">Group</div><button class="dropdown-item" id="viewProfileBtn">${ICONS.profile}<span>Group info</span></button><button class="dropdown-item" id="clearChatBtn">${ICONS.trash}<span>Clear chat</span></button>${isAdmin?`<button class="dropdown-item" id="renameGroupBtn">${ICONS.copy}<span>Rename group</span></button>`:""}<button class="dropdown-item danger-item" id="leaveGroupMenuBtn">${ICONS.block}<span>Leave group</span></button>`;
    menu.querySelector("#viewProfileBtn")?.addEventListener("click",()=>{menu.hidden=true;openProfileDrawer();});
    menu.querySelector("#clearChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await clearChatForMe();});
    menu.querySelector("#renameGroupBtn")?.addEventListener("click",()=>{menu.hidden=true;promptRenameGroup();});
    menu.querySelector("#leaveGroupMenuBtn")?.addEventListener("click",async()=>{menu.hidden=true;await leaveGroupChat();});
    return;
  }
  const blocked=currentBlockedUsers.has(activeUser.uid);menu.innerHTML=`<div class="dropdown-label">Conversation</div><button class="dropdown-item" id="viewProfileBtn">${ICONS.profile}<span>View profile</span></button><button class="dropdown-item" id="sharedMediaBtn">${ICONS.copy}<span>Shared media</span></button><button class="dropdown-item" id="callSoonBtn">${ICONS.reply}<span>Voice / video call</span></button><button class="dropdown-item" id="clearChatBtn">${ICONS.trash}<span>Clear chat</span></button><button class="dropdown-item ${blocked?"":"danger-item"}" id="blockToggleBtn">${blocked?ICONS.unlock:ICONS.block}<span>${blocked?"Unblock user":"Block user"}</span></button>`;menu.querySelector("#viewProfileBtn")?.addEventListener("click",()=>{menu.hidden=true;openProfileDrawer();});menu.querySelector("#sharedMediaBtn")?.addEventListener("click",()=>{menu.hidden=true;openProfileDrawer();document.querySelector("#sharedMediaGrid")?.scrollIntoView({block:"nearest"});});menu.querySelector("#callSoonBtn")?.addEventListener("click",()=>{menu.hidden=true;showToast("Voice and video calls are coming soon.","info");});menu.querySelector("#clearChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await clearChatForMe();});menu.querySelector("#blockToggleBtn")?.addEventListener("click",async()=>{menu.hidden=true;const shouldBlock=!blocked;if(shouldBlock){const ok=await showConfirmDialog({title:"Block this user?",message:"They won't be able to send you messages until you unblock them.",confirmText:"Block user",cancelText:"Cancel",danger:true});if(!ok)return;}await toggleBlockUser(activeUser.uid,shouldBlock);});}

async function clearChatForMe(){
  if(!activeConversationId||!currentUser)return false;
  const ok=await showConfirmDialog({title:"Clear this chat?",message:"All messages will be removed from your view only. The other person will still see them.",confirmText:"Clear chat",cancelText:"Cancel",danger:true});
  if(!ok)return false;
  try{
    const msgsSnap=await getDocs(collection(db,"conversations",activeConversationId,"messages"));
    if(msgsSnap.empty){showToast("Chat is already empty","info");return true;}
    const docs=msgsSnap.docs;
    for(let i=0;i<docs.length;i+=450){
      const batch=writeBatch(db);
      docs.slice(i,i+450).forEach(d=>batch.update(d.ref,{deletedFor:arrayUnion(currentUser.uid)}));
      await batch.commit();
    }
    localHiddenLatest.add(activeConversationId);
    renderChatList();
    showToast("Chat cleared","success");
    return true;
  }catch(e){
    console.error("Clear chat failed",e);
    showToast(e?.code==="permission-denied"?"You don't have permission to clear this chat.":"Could not clear the chat. Try again.","error");
    return false;
  }
}

async function deleteConversationForMe(conversationId){
  if(!conversationId||!currentUser)return false;
  const ok=await showConfirmDialog({title:"Delete this chat?",message:"This removes the entire conversation from your chat list. The other person keeps their copy.",confirmText:"Delete chat",cancelText:"Cancel",danger:true});
  if(!ok)return false;
  try{
    await updateDoc(doc(db,"conversations",conversationId),{[`hiddenFor.${currentUser.uid}`]:true,[`pinned.${currentUser.uid}`]:false});
    if(activeConversationId===conversationId){activeConversationId=null;activeUser=null;$id("app")?.classList.remove("chat-open");}
    renderChatList();
    showToast("Chat deleted","success");
    return true;
  }catch(e){
    console.error("Delete chat failed",e);
    showToast(e?.code==="permission-denied"?"You don't have permission to delete this chat.":"Could not delete the chat. Try again.","error");
    return false;
  }
}

async function togglePinConversation(conversationId){
  if(!conversationId||!currentUser)return false;
  const c=conversations.find(x=>x.id===conversationId);
  const nowPinned=!(c?.pinned?.[currentUser.uid]);
  try{
    await updateDoc(doc(db,"conversations",conversationId),{[`pinned.${currentUser.uid}`]:nowPinned});
    renderChatList();
    showToast(nowPinned?"Chat pinned":"Chat unpinned","success");
    return true;
  }catch(e){
    console.error("Pin chat failed",e);
    showToast("Could not update pin. Try again.","error");
    return false;
  }
}

function closeChatItemContextMenu(){document.querySelector(".chat-item-context-menu")?.remove();}

// --- Group chat: create, rename, membership ---
async function promptRenameGroup(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const name=window.prompt("Group name",activeUser.name||"")?.trim();
  if(!name||name===activeUser.name)return;
  try{
    await updateDoc(doc(db,"conversations",activeConversationId),{groupName:name.slice(0,60)});
    activeUser.name=name.slice(0,60);
    refreshChatHeader();renderChatList();renderProfileDrawer();
    showToast("Group renamed","success");
  }catch(e){console.error("Rename group failed",e);showToast("Could not rename the group.","error");}
}

async function leaveGroupChat(){
  if(!activeConversationId||!activeUser?.isGroup||!currentUser)return;
  const ok=await showConfirmDialog({title:"Leave this group?",message:"You'll stop receiving messages from this group. You can be added back later by a member.",confirmText:"Leave group",cancelText:"Cancel",danger:true});
  if(!ok)return;
  try{
    const c=conversations.find(x=>x.id===activeConversationId);
    const remainingMembers=(c?.members||activeUser.members||[]).filter(uid=>uid!==currentUser.uid);
    const remainingAdmins=(c?.groupAdmins||activeUser.admins||[]).filter(uid=>uid!==currentUser.uid);
    await updateDoc(doc(db,"conversations",activeConversationId),{members:remainingMembers,groupAdmins:remainingAdmins});
    activeConversationId=null;activeUser=null;activeConversation=null;$id("app")?.classList.remove("chat-open");
    closeProfileDrawer();renderChatList();
    showToast("You left the group","success");
  }catch(e){console.error("Leave group failed",e);showToast(e?.code==="permission-denied"?"Could not leave the group.":"Something went wrong leaving the group.","error");}
}

function contactList(){
  // People you already have a direct (1:1) conversation with — the pool group members are picked from.
  return conversations.filter(c=>c.type!=="group").map(c=>{const uid=otherUid(c);const user=userListeners.get(uid)?.data;return user?{uid,...user}:null;}).filter(Boolean);
}

function openNewGroupModal(){
  openModal("newGroupModal");
  const nameInput=$id("newGroupName");if(nameInput)nameInput.value="";
  $id("newGroupError").textContent="";
  renderGroupMemberPicker();
}

function renderGroupMemberPicker(){
  const box=$id("newGroupMemberPicker");if(!box)return;
  const contacts=contactList();
  if(!contacts.length){box.innerHTML='<div class="empty-state">Start a few 1:1 chats first — groups are built from people you already talk to.</div>';return;}
  box.innerHTML=contacts.map(u=>`<label class="contact-pick-row"><input type="checkbox" value="${escapeHtml(u.uid)}">${avatarHtml(u,{dot:false})}<span class="meta"><strong>${escapeHtml(u.name||"User")}</strong>${u.username?`<span>@${escapeHtml(u.username)}</span>`:""}</span></label>`).join("");
  contacts.forEach(u=>paintAvatar(box.querySelector(`.contact-pick-row input[value="${CSS.escape(u.uid)}"]`)?.closest(".contact-pick-row")?.querySelector(".avatar"),u));
}

async function createGroup(){
  const errBox=$id("newGroupError");errBox.textContent="";
  const name=$id("newGroupName")?.value.trim()||"";
  const checked=[...document.querySelectorAll("#newGroupMemberPicker input[type=checkbox]:checked")].map(i=>i.value);
  if(!name){errBox.textContent="Give your group a name.";return;}
  if(checked.length<2){errBox.textContent="Pick at least 2 people to start a group.";return;}
  const btn=$id("createGroupBtn");btn.disabled=true;btn.textContent="Creating…";
  try{
    const members=[currentUser.uid,...checked];
    const ref=doc(collection(db,"conversations"));
    const unread={};members.forEach(uid=>{unread[uid]=0;});
    await setDoc(ref,{
      type:"group",members,groupName:name.slice(0,60),groupPhotoURL:"",
      groupAdmins:[currentUser.uid],createdBy:currentUser.uid,createdAt:serverTimestamp(),
      lastMessage:"",lastMessageType:"text",lastMessageSenderId:"",lastMessageId:"",lastMessageTime:serverTimestamp(),
      unread,pinned:{},hiddenFor:{}
    });
    closeModal("newGroupModal");
    showToast("Group created 🎉","success");
    await openChatById(ref.id);
  }catch(e){
    console.error("Create group failed",e);
    errBox.textContent=e?.code==="permission-denied"?"Could not create the group (permission denied).":"Something went wrong creating the group.";
  }finally{
    btn.disabled=false;btn.textContent="Create group";
  }
}

async function addGroupMembers(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const existing=new Set(activeUser.members||[]);
  const candidates=contactList().filter(u=>!existing.has(u.uid));
  if(!candidates.length){showToast("Everyone you chat with is already in this group.","info");return;}
  const picked=window.prompt(`Add by CUNNACT ID (comma-separated). Available: ${candidates.map(u=>u.username?`@${u.username}`:u.name).join(", ")}`);
  if(!picked)return;
  const wanted=picked.split(",").map(s=>s.trim().replace(/^@/,"").toLowerCase()).filter(Boolean);
  const toAdd=candidates.filter(u=>wanted.includes((u.username||"").toLowerCase())).map(u=>u.uid);
  if(!toAdd.length){showToast("Couldn't match those CUNNACT IDs to your contacts.","error");return;}
  try{
    const newMembers=[...existing,...toAdd];
    const unreadPatch={};toAdd.forEach(uid=>{unreadPatch[`unread.${uid}`]=0;});
    await updateDoc(doc(db,"conversations",activeConversationId),{members:newMembers,groupAdmins:activeUser.admins||[],...unreadPatch});
    showToast("Members added","success");
    await openChatById(activeConversationId);
  }catch(e){console.error("Add members failed",e);showToast("Could not add members.","error");}
}

async function removeGroupMember(uid){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const ok=await showConfirmDialog({title:"Remove this member?",message:"They'll lose access to this group's messages.",confirmText:"Remove",cancelText:"Cancel",danger:true});
  if(!ok)return;
  try{
    const newMembers=(activeUser.members||[]).filter(m=>m!==uid);
    const newAdmins=(activeUser.admins||[]).filter(m=>m!==uid);
    await updateDoc(doc(db,"conversations",activeConversationId),{members:newMembers,groupAdmins:newAdmins});
    showToast("Member removed","success");
    await openChatById(activeConversationId);
  }catch(e){console.error("Remove member failed",e);showToast(e?.code==="permission-denied"?"Only group admins can remove members.":"Could not remove that member.","error");}
}

function showChatItemContextMenu(conversationId,anchorEl,clientX,clientY){
  closeChatItemContextMenu();
  const c=conversations.find(x=>x.id===conversationId);
  const isPinned=!!(c?.pinned?.[currentUser?.uid]);
  const menu=document.createElement("div");
  menu.className="message-action-menu chat-item-context-menu";
  menu.innerHTML=`<button class="menu-item pin-chat" type="button">${ICONS.bookmark}<span>${isPinned?"Unpin chat":"Pin chat"}</span></button><button class="menu-item danger-item delete-chat" type="button">${ICONS.trash}<span>Delete chat</span></button>`;
  document.body.appendChild(menu);
  const rect=anchorEl.getBoundingClientRect();
  const mr=menu.getBoundingClientRect();
  const top=Math.min(Math.max(8,clientY||rect.top),innerHeight-mr.height-8);
  const left=Math.min(Math.max(8,clientX||rect.left),innerWidth-mr.width-8);
  menu.style.top=`${top}px`;menu.style.left=`${left}px`;
  menu.querySelector(".pin-chat")?.addEventListener("click",async()=>{menu.remove();await togglePinConversation(conversationId);});
  menu.querySelector(".delete-chat")?.addEventListener("click",async()=>{menu.remove();await deleteConversationForMe(conversationId);});
  setTimeout(()=>document.addEventListener("click",closeChatItemContextMenu,{once:true}),0);
}
async function loadBlockedUsers(){currentBlockedUsers=new Set();if(!currentUser)return;try{const snap=await getDocs(collection(db,"users",currentUser.uid,"blockedUsers"));snap.docs.forEach(d=>currentBlockedUsers.add(d.id));}catch(e){console.warn(e);}}
async function toggleBlockUser(uid,shouldBlock){try{const ref=doc(db,"users",currentUser.uid,"blockedUsers",uid);if(shouldBlock)await setDoc(ref,{uid,createdAt:serverTimestamp()});else await deleteDoc(ref);shouldBlock?currentBlockedUsers.add(uid):currentBlockedUsers.delete(uid);renderChatList();refreshChatHeader();setComposerState();showToast(shouldBlock?"User blocked":"User unblocked","success");}catch(e){console.error(e);showToast("Could not update block setting.","error");}}

/* Typing */
function listenTyping(){unsubscribeTyping?.();if(!activeConversationId)return;const dots='<i></i><i></i><i></i> ';unsubscribeTyping=onSnapshot(collection(db,"conversations",activeConversationId,"typing"),snap=>{const el=$id("chatTyping");if(!el)return;if(activeUser?.isGroup){const typers=snap.docs.filter(d=>d.id!==currentUser.uid&&d.data()?.typing===true).map(d=>(activeGroupMembers.get(d.id)?.name||"Someone").split(" ")[0]);el.hidden=!typers.length;if(typers.length)el.innerHTML=dots+escapeHtml(`${typers.slice(0,2).join(", ")}${typers.length>1?" are":" is"} typing…`);return;}const other=activeUser?.uid;const state=snap.docs.some(d=>d.id===other&&d.data()?.typing===true);el.hidden=!state;el.innerHTML=dots+"typing…";},()=>{const el=$id("chatTyping");if(el)el.hidden=true;});}
const sendTypingState=debounce(async(typing)=>{if(!activeConversationId||!currentUser)return;const ref=doc(db,"conversations",activeConversationId,"typing",currentUser.uid);try{if(typing)await setDoc(ref,{uid:currentUser.uid,typing:true,updatedAt:serverTimestamp()},{merge:true});else await deleteDoc(ref);}catch(e){}},450);
function handleTypingInput(){const typing=!!$id("messageInput")?.value.trim();clearTimeout(window.__cunnactTypingTimer);if(typing){sendTypingState(true);window.__cunnactTypingTimer=setTimeout(()=>sendTypingState(false),2500);}else sendTypingState(false);}
function stopTyping(){clearTimeout(window.__cunnactTypingTimer);sendTypingState(false);}

/* Messages */
function listenMessages(){
  const token=++messageListenerToken;
  currentMessages=[];
  activeMessageMap=new Map();
  renderedMessageElsCleanup();
  const box=$id("messages");
  if(!box)return;
  box.innerHTML='<div class="empty-state big">Loading messages…</div>';
  const isNearBottom=()=>box.scrollHeight-box.scrollTop-box.clientHeight<120;

  readObserver?.disconnect();
  readObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(entry.isIntersecting&&entry.intersectionRatio>0.35){
        const id=entry.target.dataset.messageId;
        if(id)queueRead(id);
      }
    }
  },{root:box,threshold:[0.35]});

  let settled=false;
  let retryTimer=0;
  const showLoadError=(message,detail="")=>{
    if(token!==messageListenerToken)return;
    clearTimeout(retryTimer);
    box.innerHTML=`<div class="empty-state">${escapeHtml(message)}<br><span>${escapeHtml(detail)}</span><br><button type="button" class="btn btn-soft btn-sm" id="retryMessagesBtn" style="margin-top:12px">Retry</button></div>`;
    $id("retryMessagesBtn")?.addEventListener("click",()=>listenMessages(),{once:true});
  };

  const applySnapshot=(snap)=>{
    if(token!==messageListenerToken)return;
    settled=true;
    clearTimeout(retryTimer);
    const wasAtBottom=isNearBottom();
    const beforeCount=currentMessages.length;
    const changes=snap.docChanges();
    try{
      // Sort in the browser so legacy messages without perfect Firestore ordering/indexing
      // cannot leave the chat stuck on a loading state.
      currentMessages=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
        const at=timestampDate(a.createdAt)?.getTime()??0;
        const bt=timestampDate(b.createdAt)?.getTime()??0;
        return at-bt || String(a.id).localeCompare(String(b.id));
      });
      activeMessageMap=new Map(currentMessages.map(m=>[m.id,m]));
      reconcileMessageDOM();

      const incomingAdded=changes.some(c=>c.type==="added"&&c.doc.data()?.senderId!==currentUser.uid&&beforeCount>0);
      if(incomingAdded&&document.visibilityState==="visible")playReceive();
      const selfAdded=changes.some(c=>c.type==="added"&&c.doc.data()?.senderId===currentUser.uid);
      if(selfAdded||wasAtBottom||beforeCount===0)requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight;});

      queueDeliveredForIncoming(currentMessages);
      if(document.visibilityState==="visible")observeVisibleIncoming();
      cleanupExpiredMessages(db,activeConversationId,currentMessages,currentUser.uid,updateDoc).catch(()=>{});

      // Only reconcile the conversation preview when the newest message actually changed.
      if(changes.some(c=>c.type==="added"||c.type==="removed"))updateConversationPreviewFromMessages();
    }catch(err){
      console.error("Message render failed",err);
      showLoadError("Messages couldn't be displayed.",err?.message||"UI rendering error");
    }
  };

  const handleError=(e)=>{
    if(token!==messageListenerToken)return;
    console.error("Message listener failed",e);
    clearTimeout(retryTimer);
    const code=e?.code||"unknown";
    if(["failed-precondition","invalid-argument"].includes(code)){
      // Retry without orderBy for legacy data / index mismatches.
      unsubscribeMessages?.();
      const fallbackQuery=query(collection(db,"conversations",activeConversationId,"messages"),limit(100));
      unsubscribeMessages=onSnapshot(fallbackQuery,applySnapshot,(fallbackErr)=>showLoadError("Messages couldn't be loaded.",fallbackErr?.code||code));
      return;
    }
    settled=true;
    const detail=code==="permission-denied"?"Firebase rules are blocking message reads.":"Check your connection and Firebase configuration.";
    showLoadError("Messages couldn't be loaded.",detail+` (${code})`);
  };

  // Load the newest 100 messages first. This avoids showing an old slice of a
  // long conversation and gives Firestore a deterministic index-free query.
  // We reverse them in applySnapshot so the chat still renders oldest → newest.
  const messagesQuery=query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(100));
  unsubscribeMessages=onSnapshot(messagesQuery,applySnapshot,handleError);

  // Never leave a user staring at an infinite loader if the listener is stalled.
  retryTimer=setTimeout(()=>{
    if(token!==messageListenerToken||settled)return;
    console.warn("Message listener timed out; retrying with a fresh listener.");
    unsubscribeMessages?.();
    const freshQuery=query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(100));
    unsubscribeMessages=onSnapshot(freshQuery,applySnapshot,(e)=>{
      if(["failed-precondition","invalid-argument"].includes(e?.code)){
        // Legacy installations may contain records without createdAt. Fall back
        // to a plain listener rather than trapping the user on Loading.
        unsubscribeMessages?.();
        const fallbackQuery=query(collection(db,"conversations",activeConversationId,"messages"),limit(100));
        unsubscribeMessages=onSnapshot(fallbackQuery,applySnapshot,(fallbackErr)=>showLoadError("Messages couldn't be loaded.",fallbackErr?.code||e?.code||"listener-error"));
      } else showLoadError("Messages couldn't be loaded.",e?.code||"listener-timeout");
    });
  },7000);

  cleanupInterval=startPeriodicCleanup(db,activeConversationId,()=>currentMessages,currentUser.uid,updateDoc);
}

function renderedMessageElsCleanup(){document.querySelectorAll("#messages .message, #messages .date-separator").forEach(el=>el.remove());}
function reconcileMessageDOM(){
  const box=$id("messages");if(!box)return;
  const visible=currentMessages.filter(m=>!isDeletedForUser(m,currentUser.uid)&&!shouldExpireMessage(m,currentUser.uid));
  if(!visible.length){box.innerHTML='<div class="empty-state big">No messages yet.<br><span>Send a message to start the conversation.</span></div>';activeMessageMap=new Map();return;}
  box.querySelectorAll(".empty-state").forEach(e=>e.remove());
  const visibleIds=new Set(visible.map(m=>m.id));
  document.querySelectorAll("#messages .message").forEach(el=>{if(!visibleIds.has(el.dataset.messageId))el.remove();});
  visible.forEach((message)=>{let el=box.querySelector(`.message[data-message-id="${CSS.escape(message.id)}"]`);if(!el){el=buildMessageElement(message);box.appendChild(el);}else updateMessageElement(el,message);if(readObserver&&message.receiverId===currentUser.uid)readObserver.observe(el);});
  // Ensure DOM order matches the timestamp order without replacing nodes.
  const ordered=visible.map(m=>box.querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`)).filter(Boolean);ordered.forEach((el,i)=>{const wanted=box.querySelectorAll(".message")[i];if(wanted!==el)box.insertBefore(el,wanted||null);});
  syncDateSeparators(visible); syncMessageGrouping(visible); observeVisibleIncoming();
}
function syncDateSeparators(visible){document.querySelectorAll("#messages .date-separator").forEach(e=>e.remove());let lastDay="";visible.forEach(m=>{const d=timestampDate(m.createdAt);if(!d)return;const day=d.toDateString();if(day===lastDay)return;lastDay=day;const first=$id("messages").querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`);if(first){const sep=document.createElement("div");sep.className="date-separator";sep.textContent=day===new Date().toDateString()?"Today":day===new Date(Date.now()-86400000).toDateString()?"Yesterday":d.toLocaleDateString([], {day:"numeric",month:"short",year:d.getFullYear()===new Date().getFullYear()?undefined:"numeric"});$id("messages").insertBefore(sep,first);}});}
function syncMessageGrouping(visible){visible.forEach((m,i)=>{const el=$id("messages").querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`);if(!el)return;const prev=visible[i-1],next=visible[i+1],d=timestampDate(m.createdAt)?.getTime()||0,pd=timestampDate(prev?.createdAt)?.getTime()||0,nd=timestampDate(next?.createdAt)?.getTime()||0;const samePrev=prev&&prev.senderId===m.senderId&&d-pd<5*60*1000,sameNext=next&&next.senderId===m.senderId&&nd-d<5*60*1000;el.classList.toggle("group-start",!samePrev);el.classList.toggle("group-middle",!!samePrev&&!!sameNext);el.classList.toggle("group-end",!!samePrev&&!sameNext);el.classList.toggle("solo",!samePrev&&!sameNext);});}
function buildMessageElement(message){
  const outgoing=message.senderId===currentUser.uid;const el=document.createElement("article");el.className=`message ${outgoing?"outgoing":"incoming"}`;el.dataset.messageId=message.id;el._message=message;
  const bubble=document.createElement("div");bubble.className="message-bubble";el.appendChild(bubble);
  if(!outgoing&&activeUser?.isGroup){const senderName=(activeGroupMembers.get(message.senderId)?.name||userListeners.get(message.senderId)?.data?.name||"Member");const label=document.createElement("div");label.className="sender-name";label.textContent=senderName;bubble.appendChild(label);}
  if(message.replyTo){const quote=document.createElement("button");quote.type="button";quote.className="reply-quote";quote.innerHTML=`<span>${escapeHtml(message.replyTo.senderName||"Message")}</span><p>${escapeHtml(message.replyTo.text||"Photo")}</p>`;quote.addEventListener("click",()=>scrollToMessage(message.replyTo.messageId));bubble.appendChild(quote);}
  if(message.type==="image"&&isTrustedImageUrl(message.imageURL)){el.classList.add("image-message");const img=document.createElement("img");img.src=imageUrl(message.imageURL,"chat");img.alt="Shared image";img.loading="lazy";img.addEventListener("click",()=>openLightbox(message.imageURL));bubble.appendChild(img);}else{const p=document.createElement("p");p.textContent=message.text||"Attachment unavailable";bubble.appendChild(p);}
  const meta=document.createElement("div");meta.className="message-meta";const time=document.createElement("small");time.textContent=message.createdAt?.toDate?formatTime(message.createdAt.toDate()):"";meta.appendChild(time);if(outgoing){const status=document.createElement("span");status.className="delivery-check";setDeliveryIcon(status,message);meta.appendChild(status);}bubble.appendChild(meta);
  renderReactionChips(el,message);if(isSavedByUser(message,currentUser.uid)){const mark=document.createElement("span");mark.className="bookmark-icon";mark.innerHTML=ICONS.bookmark;el.appendChild(mark);}
  // No visible ••• button on the bubble — actions open via right-click (desktop) or long-press (touch), on the message itself.
  el.addEventListener("contextmenu",e=>{e.preventDefault();showMessageActions(el,el._message,outgoing,el);});
  let msgPressTimer=null,msgLongPressed=false;
  el.addEventListener("touchstart",()=>{msgLongPressed=false;msgPressTimer=setTimeout(()=>{msgLongPressed=true;if(navigator.vibrate)navigator.vibrate(12);showMessageActions(el,el._message,outgoing,el);},420);},{passive:true});
  el.addEventListener("touchend",()=>clearTimeout(msgPressTimer));
  el.addEventListener("touchmove",()=>clearTimeout(msgPressTimer));
  el.addEventListener("click",e=>{if(msgLongPressed){e.preventDefault();msgLongPressed=false;}});
  return el;
}
function updateMessageElement(el,message){el._message=message;const outgoing=message.senderId===currentUser.uid;const bubble=el.querySelector(".message-bubble");if(!bubble)return;const quote=bubble.querySelector(".reply-quote");if(message.replyTo&&!quote){const q=document.createElement("button");q.type="button";q.className="reply-quote";q.innerHTML=`<span>${escapeHtml(message.replyTo.senderName||"Message")}</span><p>${escapeHtml(message.replyTo.text||"Photo")}</p>`;q.addEventListener("click",()=>scrollToMessage(message.replyTo.messageId));bubble.prepend(q);}const meta=bubble.querySelector(".message-meta");if(meta&&outgoing){const status=meta.querySelector(".delivery-check")||document.createElement("span");status.className="delivery-check";setDeliveryIcon(status,message);if(!status.parentNode)meta.appendChild(status);}renderReactionChips(el,message);const saved=isSavedByUser(message,currentUser.uid);const oldMark=el.querySelector(".bookmark-icon");if(saved&&!oldMark){const mark=document.createElement("span");mark.className="bookmark-icon";mark.innerHTML=ICONS.bookmark;el.appendChild(mark);}if(!saved&&oldMark)oldMark.remove();}
function setDeliveryIcon(status,message){const delivered=!!message.deliveredBy?.[activeUser?.uid],read=!!message.readBy?.[activeUser?.uid];status.classList.toggle("read",read);status.innerHTML=read?ICONS.check+ICONS.check:delivered?ICONS.check+ICONS.check:ICONS.check;}
function renderReactionChips(el,message){let wrap=el.querySelector(".message-reactions"),entries=Object.entries(message.reactions||{}).filter(([,v])=>v);if(!entries.length){wrap?.remove();return;}if(!wrap){wrap=document.createElement("div");wrap.className="message-reactions";el.appendChild(wrap);}const counts=new Map();entries.forEach(([uid,emoji])=>counts.set(emoji,(counts.get(emoji)||0)+1));wrap.innerHTML="";counts.forEach((count,emoji)=>{const b=document.createElement("button");b.type="button";b.className="reaction-chip";b.textContent=`${emoji}${count>1?` ${count}`:""}`;b.addEventListener("click",()=>toggleReaction(message.id,emoji,el));wrap.appendChild(b);});}
function showMessageActions(messageEl,message,isOutgoing,anchor){closeMessageActionMenus();const menu=document.createElement("div");menu.className="message-action-menu";const saved=isSavedByUser(message,currentUser.uid);menu.innerHTML=`<div class="reaction-picker">${["❤️","😂","👍","😮","😢","🔥"].map(e=>`<button type="button" class="reaction-choice" data-reaction="${e}" aria-label="React ${e}">${e}</button>`).join("")}</div><button class="menu-item reply-msg" type="button">${ICONS.reply}<span>Reply</span></button><button class="menu-item copy-msg" type="button">${ICONS.copy}<span>Copy text</span></button><button class="menu-item save-msg" type="button">${ICONS.bookmark}<span>${saved?"Unsave message":"Save message"}</span></button>${isOutgoing?`<button class="menu-item danger-item delete-msg" type="button">${ICONS.trash}<span>Delete for everyone</span></button>`:""}<button class="menu-item danger-item delete-for-me" type="button">${ICONS.trash}<span>Delete for me</span></button>`;document.body.appendChild(menu);const rect=anchor.getBoundingClientRect();const mr=menu.getBoundingClientRect();const top=rect.bottom+8+mr.height>innerHeight?rect.top-mr.height-8:rect.bottom+8;const left=Math.min(Math.max(8,rect.left),innerWidth-mr.width-8);menu.style.top=`${Math.max(8,top)}px`;menu.style.left=`${left}px`;
  menu.querySelectorAll(".reaction-choice").forEach(b=>b.addEventListener("click",async()=>{await toggleReaction(message.id,b.dataset.reaction,messageEl);menu.remove();}));
  menu.querySelector(".reply-msg")?.addEventListener("click",()=>{startReply(message);menu.remove();});
  menu.querySelector(".copy-msg")?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(message.text||"");showToast("Message copied","success");}catch{showToast("Could not copy message","error");}menu.remove();});
  menu.querySelector(".save-msg")?.addEventListener("click",async()=>{await toggleSaveMessage(message.id,saved);menu.remove();});
  menu.querySelector(".delete-msg")?.addEventListener("click",async()=>{playDelete();await deleteMessageForEveryone(message.id);menu.remove();});
  menu.querySelector(".delete-for-me")?.addEventListener("click",async()=>{playDelete();await deleteMessageForMe(message.id,messageEl);menu.remove();});
}
function closeMessageActionMenus(){document.querySelectorAll(".message-action-menu").forEach(m=>m.remove());}
async function toggleReaction(messageId,emoji){try{await runTransaction(db,async(tx)=>{const ref=doc(db,"conversations",activeConversationId,"messages",messageId),snap=await tx.get(ref);if(!snap.exists())throw new Error("MESSAGE_NOT_FOUND");const reactions={...(snap.data().reactions||{})};reactions[currentUser.uid]=reactions[currentUser.uid]===emoji?null:emoji;tx.update(ref,{reactions});});}catch(e){console.error(e);showToast("Could not update reaction.","error");}}
async function toggleSaveMessage(messageId,currentSaved){try{const ref=doc(db,"conversations",activeConversationId,"messages",messageId),savedRef=doc(db,"users",currentUser.uid,"savedMessages",messageId),message=currentMessages.find(m=>m.id===messageId);const batch=writeBatch(db);batch.update(ref,{savedBy:currentSaved?arrayRemove(currentUser.uid):arrayUnion(currentUser.uid)});if(currentSaved)batch.delete(savedRef);else batch.set(savedRef,{messageId,conversationId:activeConversationId,partnerUid:activeUser.uid,savedAt:serverTimestamp(),type:message?.type||"text",text:(message?.text||"").slice(0,500),imageURL:message?.imageURL||""});await batch.commit();showToast(currentSaved?"Message unsaved":"Message saved 🔖",currentSaved?"info":"success");if(!currentSaved)playSave();return true;}catch(e){console.error(e);showToast("Could not update saved message.","error");return false;}}
async function deleteMessageForEveryone(messageId){const ok=await showConfirmDialog({title:"Delete message for everyone?",message:"This message will be removed from both sides of the conversation.",confirmText:"Delete message",cancelText:"Keep message",danger:true});if(!ok)return false;try{await deleteDoc(doc(db,"conversations",activeConversationId,"messages",messageId));await refreshConversationPreview();showToast("Message deleted for everyone","success");return true;}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Only the sender can delete this message.":"Could not delete the message.","error");return false;}}
async function deleteMessageForMe(messageId,messageEl){try{messageEl?.classList.add("deleting");await updateDoc(doc(db,"conversations",activeConversationId,"messages",messageId),{deletedFor:arrayUnion(currentUser.uid)});const c=conversations.find(x=>x.id===activeConversationId);if(c?.lastMessageId===messageId)localHiddenLatest.add(activeConversationId);showToast("Message deleted for you","info");return true;}catch(e){messageEl?.classList.remove("deleting");console.error(e);showToast("Could not delete the message for you.","error");return false;}}
async function refreshConversationPreview(){const c=conversations.find(x=>x.id===activeConversationId);if(!c)return;try{const snap=await getDocs(query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(1)));if(!snap.empty){const m={id:snap.docs[0].id,...snap.docs[0].data()};await updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:m.type==="image"?"":(m.text||"").slice(0,500),lastMessageType:m.type||"text",lastMessageSenderId:m.senderId||"",lastMessageId:m.id,lastMessageTime:m.createdAt||serverTimestamp()});}else{await updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:"",lastMessageType:"text",lastMessageSenderId:"",lastMessageId:"",lastMessageTime:serverTimestamp()});}}catch(e){console.warn("Preview reconcile failed",e);}}
function updateConversationPreviewFromMessages(){const c=conversations.find(x=>x.id===activeConversationId);if(!c||!currentMessages.length)return;const newest=currentMessages[currentMessages.length-1];if(newest&&c.lastMessageId!==newest.id){const preview=newest.type==="image"?"":(newest.text||"").slice(0,500);updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:preview,lastMessageType:newest.type||"text",lastMessageSenderId:newest.senderId||"",lastMessageId:newest.id,lastMessageTime:newest.createdAt||serverTimestamp()}).catch(()=>{});}}

/* Delivery receipts */
function queueDeliveredForIncoming(messages){
  if(!currentUser||!messages?.length)return;
  messages.forEach(m=>{
    if(m.senderId!==currentUser.uid && m.receiverId===currentUser.uid && !m.deliveredBy?.[currentUser.uid] && !isDeletedForUser(m,currentUser.uid)) queuedDeliveredIds.add(m.id);
  });
  clearTimeout(deliveredFlushTimer);
  deliveredFlushTimer=setTimeout(flushDelivered,180);
}
async function flushDelivered(){
  if(!activeConversationId||!currentUser||!queuedDeliveredIds.size)return;
  const ids=[...queuedDeliveredIds].slice(0,450);
  ids.forEach(id=>queuedDeliveredIds.delete(id));
  try{
    const batch=writeBatch(db);
    ids.forEach(id=>batch.update(doc(db,"conversations",activeConversationId,"messages",id),{[`deliveredBy.${currentUser.uid}`]:serverTimestamp()}));
    await batch.commit();
  }catch(e){ids.forEach(id=>queuedDeliveredIds.add(id));console.warn("Delivery batch failed",e);}
}

/* Read receipts */
function queueRead(messageId){const m=activeMessageMap.get(messageId);if(!m||m.receiverId!==currentUser.uid||m.readBy?.[currentUser.uid]||isDeletedForUser(m,currentUser.uid))return;queuedReadIds.add(messageId);clearTimeout(readFlushTimer);readFlushTimer=setTimeout(flushQueuedReads,220);}
async function flushQueuedReads(){if(!activeConversationId||!currentUser||!queuedReadIds.size)return;const ids=[...queuedReadIds].slice(0,450);ids.forEach(id=>queuedReadIds.delete(id));try{const batch=writeBatch(db);ids.forEach(id=>batch.update(doc(db,"conversations",activeConversationId,"messages",id),{[`readBy.${currentUser.uid}`]:serverTimestamp()}));await batch.commit();}catch(e){ids.forEach(id=>queuedReadIds.add(id));console.warn("Read batch failed",e);}}
function observeVisibleIncoming(){document.querySelectorAll("#messages .message").forEach(el=>{const m=activeMessageMap.get(el.dataset.messageId);if(m?.receiverId===currentUser.uid)readObserver?.observe(el);});}
function scrollToMessage(id){const el=$id("messages")?.querySelector(`.message[data-message-id="${CSS.escape(id)}"]`);if(el){el.scrollIntoView({block:"center",behavior:"smooth"});el.classList.add("flash-message");setTimeout(()=>el.classList.remove("flash-message"),700);}}

/* Reply / composer */
function startReply(message){replyTarget={messageId:message.id,senderId:message.senderId,senderName:message.senderId===currentUser.uid?"You":(activeUser?.name||"User"),text:message.type==="image"?"📷 Photo":String(message.text||"")};$id("replyBar").hidden=false;$id("replyAuthor").textContent=replyTarget.senderName;$id("replyPreview").textContent=replyTarget.text;$id("messageInput")?.focus();}
function clearReply(){replyTarget=null;const bar=$id("replyBar");if(bar)bar.hidden=true;}
async function handleMessageSubmit(e){e.preventDefault();if(sendingMessage||!activeUser||!activeConversationId||isBlockedByEither())return;const input=$id("messageInput"),text=input.value.trim();if(!text)return;sendingMessage=true;const sendBtn=$id("messageForm").querySelector('button[type="submit"]');input.value="";autoGrowComposer();stopTyping();const savedReply=replyTarget;clearReply();try{await sendMessage({type:"text",text,replyTo:savedReply});playSend();input.focus();}catch(err){console.error("Send message failed",err);input.value=text;if(savedReply)startReply(savedReply);autoGrowComposer();showToast(err?.code==="permission-denied"?"Message blocked by chat permissions.":"Message could not be sent. Please try again.","error");}finally{sendingMessage=false;setComposerState();}}
async function sendMessage({type,text,imageURL,replyTo}){if(!currentUser||!activeUser||!activeConversationId)throw new Error("NO_ACTIVE_CHAT");if(isBlockedByEither())throw new Error("BLOCKED");const isGroup=!!activeUser.isGroup;const ref=doc(db,"conversations",activeConversationId,"messages",crypto.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random().toString(36).slice(2)}`);const batch=writeBatch(db);batch.set(ref,{senderId:currentUser.uid,...(isGroup?{}:{receiverId:activeUser.uid}),type,...(type==="image"?{imageURL}:{text:String(text||"").slice(0,5000)}),...(replyTo?{replyTo}:{}) ,createdAt:serverTimestamp(),savedBy:[],deletedFor:[],readBy:{},deliveredBy:{},reactions:{}});const unreadPatch={};if(isGroup)(activeUser.members||[]).forEach(uid=>{if(uid!==currentUser.uid)unreadPatch[`unread.${uid}`]=increment(1);});else unreadPatch[`unread.${activeUser.uid}`]=increment(1);batch.update(doc(db,"conversations",activeConversationId),{lastMessage:type==="image"?"":String(text||"").slice(0,500),lastMessageType:type,lastMessageSenderId:currentUser.uid,lastMessageId:ref.id,lastMessageTime:serverTimestamp(),...unreadPatch});await batch.commit();}

/* Image */
async function handleImageSelection(){const file=$id("fileInput").files?.[0];$id("fileInput").value="";if(!file||!activeUser||!activeConversationId||isBlockedByEither())return;try{await validateImageFile(file);}catch(e){showToast(e instanceof UploadError?e.userMessage:UPLOAD_MESSAGES.invalid,"error");return;}pendingImageFile=file;pendingImageUrl=URL.createObjectURL(file);$id("imagePreviewThumb").src=pendingImageUrl;$id("imagePreviewStatus").textContent="Your image is ready.";$id("imagePreviewProgress").style.width="0%";$id("imagePreviewBar").hidden=false;}
function cancelImagePreview(){uploadController?.abort();clearImagePreview();}
async function sendPendingImage(){
  if(!pendingImageFile||!activeConversationId||!activeUser||isBlockedByEither())return;
  const file=pendingImageFile;
  const savedReply=replyTarget;
  $id("imagePreviewSend").disabled=true;
  $id("imagePreviewBar").classList.add("uploading");
  uploadController=new AbortController();
  try{
    const url=await uploadImageToCloudinary(file,{signal:uploadController.signal,onProgress:p=>$id("imagePreviewProgress").style.width=`${Math.round(p*100)}%`});
    await sendMessage({type:"image",imageURL:url,replyTo:savedReply});
    playSend();showToast("Photo sent","success");clearImagePreview();clearReply();
  }catch(e){
    if(e?.kind!=="aborted"){console.error(e);$id("imagePreviewStatus").textContent=e instanceof UploadError?e.userMessage:"Photo could not be sent.";$id("imagePreviewSend").disabled=false;}
  }
}
function clearImagePreview(){if(pendingImageUrl)URL.revokeObjectURL(pendingImageUrl);pendingImageFile=null;pendingImageUrl=null;uploadController=null;const bar=$id("imagePreviewBar");if(!bar)return;bar.hidden=true;bar.classList.remove("uploading");$id("imagePreviewSend").disabled=false;$id("imagePreviewThumb").src="";}
function autoGrowComposer(){const input=$id("messageInput");if(!input)return;input.style.height="auto";input.style.height=`${Math.min(input.scrollHeight,140)}px`;}

/* Profile drawer / shared media */
function openProfileDrawer(){if(!activeUser||activeUser.uid===currentUser?.uid)return;renderProfileDrawer();$id("profileDrawer").hidden=false;$id("app")?.classList.add("drawer-open");}
function closeProfileDrawer(){const d=$id("profileDrawer");if(!d)return;d.hidden=true;$id("app")?.classList.remove("drawer-open");}
function renderProfileDrawer(){
  if(!activeUser)return;
  if(activeUser.isGroup){
    paintAvatar($id("drawerAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name});
    $id("drawerName").textContent=activeUser.name||"Group";
    $id("drawerUsername").textContent=`${activeUser.memberCount||activeUser.members?.length||0} members`;
    $id("drawerBio").textContent="";
    $id("drawerViewProfile").hidden=true;
    const isAdmin=(activeUser.admins||[]).includes(currentUser.uid);
    const section=$id("groupMembersSection");
    if(section){
      section.hidden=false;
      const list=$id("groupMembersList");
      list.innerHTML=(activeUser.members||[]).map(uid=>{
        const u=uid===currentUser.uid?{name:"You",photoURL:currentUserData.photoURL}:(activeGroupMembers.get(uid)||userListeners.get(uid)?.data||{name:"Member"});
        const isMemberAdmin=(activeUser.admins||[]).includes(uid);
        return `<div class="group-member-row" data-uid="${escapeHtml(uid)}">${avatarHtml(u,{dot:false})}<span class="meta"><strong>${escapeHtml(u.name||"Member")}</strong>${isMemberAdmin?'<span class="admin-tag">Admin</span>':""}</span>${isAdmin&&uid!==currentUser.uid?`<button class="remove-member" type="button" aria-label="Remove member">${ICONS.trash}</button>`:""}</div>`;
      }).join("");
      (activeUser.members||[]).forEach(uid=>{const u=uid===currentUser.uid?{name:"You",photoURL:currentUserData.photoURL}:(activeGroupMembers.get(uid)||userListeners.get(uid)?.data||{name:"Member"});paintAvatar(list.querySelector(`[data-uid="${CSS.escape(uid)}"] .avatar`),u);});
      list.querySelectorAll(".remove-member").forEach(btn=>btn.addEventListener("click",()=>removeGroupMember(btn.closest(".group-member-row").dataset.uid)));
      $id("addGroupMembersBtn").hidden=!isAdmin;
      $id("leaveGroupBtn").hidden=false;
    }
    const grid=$id("sharedMediaGrid");if(!grid)return;
    const images=currentMessages.filter(m=>m.type==="image"&&isTrustedImageUrl(m.imageURL)).slice(-12).reverse();
    grid.innerHTML=images.length?images.map(m=>`<button type="button" class="shared-media-item" data-image="${escapeHtml(m.imageURL)}"><img src="${escapeHtml(imageUrl(m.imageURL,"chat"))}" alt="Shared image" loading="lazy"></button>`).join(""):'<div class="empty-state">No shared images yet.</div>';
    grid.querySelectorAll(".shared-media-item").forEach(b=>b.addEventListener("click",()=>openLightbox(b.dataset.image)));
    return;
  }
  $id("groupMembersSection")?.setAttribute("hidden","");
  $id("drawerViewProfile").hidden=false;
  const live=userListeners.get(activeUser.uid)?.data;if(live)activeUser={...activeUser,...live};paintAvatar($id("drawerAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name,email:activeUser.email});$id("drawerName").textContent=activeUser.name||(activeUser.username?`@${activeUser.username}`:"Contact");$id("drawerUsername").textContent=activeUser.username?`@${activeUser.username}`:"";$id("drawerBio").textContent=activeUser.bio||"";const grid=$id("sharedMediaGrid");if(!grid)return;const images=currentMessages.filter(m=>m.type==="image"&&isTrustedImageUrl(m.imageURL)).slice(-12).reverse();if(!images.length){grid.innerHTML='<div class="empty-state">No shared images yet.</div>';return;}grid.innerHTML=images.map(m=>`<button type="button" class="shared-media-item" data-image="${escapeHtml(m.imageURL)}"><img src="${escapeHtml(imageUrl(m.imageURL,"chat"))}" alt="Shared image" loading="lazy"></button>`).join("");grid.querySelectorAll(".shared-media-item").forEach(b=>b.addEventListener("click",()=>openLightbox(b.dataset.image)));}

/* Saved messages */
async function renderSavedMessages(){const box=$id("savedList");if(!box||!currentUser)return;box.innerHTML='<div class="empty-state">Loading saved messages…</div>';try{const indexSnap=await getDocs(query(collection(db,"users",currentUser.uid,"savedMessages"),orderBy("savedAt","desc"),limit(100)));let entries=indexSnap.docs.map(d=>({id:d.id,...d.data()}));if(!entries.length){entries=await migrateLegacySavedMessages();}if(!entries.length){box.innerHTML='<div class="empty-state big">No saved messages yet.<br><span>Use ••• on a message to save it.</span></div>';return;}const resolved=[];for(const entry of entries){try{const s=await getDoc(doc(db,"conversations",entry.conversationId,"messages",entry.messageId));if(!s.exists())continue;const m={id:s.id,...s.data()};if(isDeletedForUser(m,currentUser.uid))continue;const partner=userListeners.get(entry.partnerUid)?.data||{uid:entry.partnerUid,name:"Conversation"};resolved.push({entry,m,partner});}catch{}}box.innerHTML=resolved.map(({entry,m,partner})=>`<button class="saved-item" type="button" data-conversation-id="${escapeHtml(entry.conversationId)}" data-message-id="${escapeHtml(entry.messageId)}">${avatarHtml(partner)}<span class="meta"><span class="top-line"><strong>${escapeHtml(partner.name||"Conversation")}</strong><span class="time">${escapeHtml(m.createdAt?.toDate?formatWhen(m.createdAt.toDate()):"")}</span></span><span class="preview-line"><span class="text">${escapeHtml(m.type==="image"?"📷 Photo":m.text||"")}</span></span></span><span class="saved-bookmark">${ICONS.bookmark}</span></button>`).join("");resolved.forEach((x,i)=>{const row=box.querySelectorAll(".saved-item")[i];paintAvatar(row?.querySelector(".avatar"),x.partner);row?.addEventListener("click",async()=>{closeModal("savedModal");await openChatById(x.entry.conversationId);setTimeout(()=>scrollToMessage(x.entry.messageId),250);});});}catch(e){console.error(e);box.innerHTML='<div class="empty-state">Saved messages could not be loaded.</div>';}}
async function migrateLegacySavedMessages(){const found=[];for(const c of conversations.slice(0,12)){try{const snap=await getDocs(query(collection(db,"conversations",c.id,"messages"),orderBy("createdAt","desc"),limit(100)));for(const d of snap.docs){const m={id:d.id,...d.data()};if(isSavedByUser(m,currentUser.uid)&&!isDeletedForUser(m,currentUser.uid)){const entry={messageId:m.id,conversationId:c.id,partnerUid:otherUid(c),savedAt:serverTimestamp(),type:m.type||"text",text:m.text||"",imageURL:m.imageURL||""};found.push(entry);await setDoc(doc(db,"users",currentUser.uid,"savedMessages",m.id),entry,{merge:true});}}}catch(e){console.warn("Legacy save migration failed",e);}}return found;}

/* Shared helpers */
function closeProfileIfDesktop(){if(innerWidth<=1100)closeProfileDrawer();}
window.addEventListener("resize",closeProfileIfDesktop);
