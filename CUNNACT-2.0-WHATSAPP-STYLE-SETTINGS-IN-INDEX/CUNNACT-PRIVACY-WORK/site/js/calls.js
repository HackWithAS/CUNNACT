import {
  db, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, limit,
  onSnapshot, serverTimestamp, arrayUnion, arrayRemove
} from "./firebase.js";
import { showToast } from "./toast.js";
import { getNotificationSettings, notificationsAreEnabled } from "./notifications.js";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    ...(Array.isArray(window.CUNNACT_TURN_SERVERS) ? window.CUNNACT_TURN_SERVERS : [])
  ]
};

const safeJson = (value) => value ? (value.sdp ? { type: value.type, sdp: value.sdp } : (value.candidate ? { candidate: value.candidate, sdpMid: value.sdpMid ?? null, sdpMLineIndex: value.sdpMLineIndex ?? null, usernameFragment: value.usernameFragment ?? null } : value)) : value;
const pairKey = (a, b) => [a, b].sort().join("__");

export function createCallController({ getCurrentUser, getConversations, getActiveConversation, getActiveUser, getUserById }) {
  const state = {
    listeners: new Map(),
    current: null,
    incoming: null,
    callHistoryConversationId: null,
    ringTimer: null,
    durationTimer: null
  };

  function user() { return getCurrentUser?.(); }
  function activeConversation() { return getActiveConversation?.(); }
  function activeUser() { return getActiveUser?.(); }
  function currentCallTitle(call) {
    if (call?.title) return call.title;
    if (call?.type === "group") return "Group call";
    return "Voice / video call";
  }

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
  }

  function setCallUi(call, mode = "active") {
    const title = document.getElementById("activeCallTitle");
    const status = document.getElementById("activeCallStatus");
    const shareBtn = document.getElementById("callShareLinkBtn");
    const endBtn = document.getElementById("callEndBtn");
    const stageName = document.getElementById("callStageName");
    const stageHint = document.getElementById("callStageHint");
    const typeLabel = document.getElementById("callStageHint");
    const peer = getPeerForCall(call);
    if (title) title.textContent = currentCallTitle(call) || peer.name;
    fillCallAvatar("activeCallAvatar", peer, currentCallTitle(call) || peer.name);
    fillCallAvatar("callStageAvatar", peer, currentCallTitle(call) || peer.name);
    const text = mode === "connecting" ? "Getting ready…" : mode === "ringing" ? "Calling…" : mode === "declined" ? "Declined" : "Connected";
    if (status) status.textContent = text;
    if (stageName) stageName.textContent = currentCallTitle(call);
    if (stageHint) stageHint.textContent = mode === "ringing" ? "Waiting for the other person to answer" : mode === "active" ? (call?.callType === "video" ? "Video call" : "Voice call") : "Connecting your call";
    if (shareBtn && state.current?.callId) shareBtn.hidden = false;
    if (endBtn) { endBtn.setAttribute("aria-label", state.current?.isInitiator ? "End call" : "Leave call"); const label=endBtn.querySelector?.(".call-control-label"); if(label) label.textContent=state.current?.isInitiator ? "End" : "Leave"; else endBtn.textContent = state.current?.isInitiator ? "End call" : "Leave call"; }
    if (typeLabel && call?.callType === "voice") typeLabel.dataset.callMode = "voice";
  }

  function stopDurationTimer() {
    if (state.durationTimer) clearInterval(state.durationTimer);
    state.durationTimer = null;
    const el = document.getElementById("callDuration");
    if (el) el.textContent = "00:00";
  }

  function startDurationTimer() {
    stopDurationTimer();
    const startedAt = Date.now();
    state.current && (state.current.connectedAt = startedAt);
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now()-startedAt)/1000));
      const el = document.getElementById("callDuration");
      if (el) el.textContent = `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
    };
    tick();
    state.durationTimer = setInterval(tick, 1000);
  }

  function clearRingTimer() {
    if (state.ringTimer) clearTimeout(state.ringTimer);
    state.ringTimer = null;
  }

  function fillCallAvatar(elementId, data, fallbackName) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.replaceChildren();
    if (data?.photoURL) {
      const img = document.createElement("img"); img.src=data.photoURL; img.alt=""; img.loading="eager"; el.appendChild(img);
    } else {
      const span=document.createElement("span"); span.className="avatar-fallback"; span.textContent=(fallbackName||data?.name||"C").trim().slice(0,1).toUpperCase(); el.appendChild(span);
    }
  }

  function getPeerForCall(call) {
    const current = user();
    const conv = getConversations?.().find(c => c.id === call?.conversationId);
    if (conv?.type === "group") {
      const initiator = call?.initiatorId ? getUserById?.(call.initiatorId) : null;
      return { name: initiator?.name || call?.title || conv.groupName || "Group call", username: initiator?.username || "", photoURL: initiator?.photoURL || conv.groupPhotoURL || "" };
    }
    const peerId = call?.participantIds?.find(uid => uid !== current?.uid);
    const peer = peerId ? getUserById?.(peerId) : null;
    const liveActive = getActiveUser?.();
    if (liveActive && liveActive.uid !== current?.uid && (!peerId || liveActive.uid === peerId)) {
      return { name: liveActive.name, username: liveActive.username || "", photoURL: liveActive.photoURL || "" };
    }
    return { name: peer?.name || call?.title || "CUNNACT user", username: peer?.username || "", photoURL: peer?.photoURL || "" };
  }

  function showIncoming(call) {
    if (!user() || state.current || state.incoming?.callId === call.id) return;
    const peer = getPeerForCall(call);
    const title = call?.type === "group" ? (call.title || peer.name || "Group call") : (peer.name || call.title || "Incoming call");
    document.getElementById("incomingCallTitle").textContent = title;
    document.getElementById("incomingCallType").textContent = call.callType === "video" ? "Incoming video call" : "Incoming voice call";
    fillCallAvatar("incomingCallAvatar", peer, title);
    state.incoming = call;
    openModal("incomingCallModal");
    try {
      const notificationSettings=getNotificationSettings();
      if (notificationSettings.calls && notificationSettings.banner && notificationsAreEnabled() && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("CUNNACT call", { body: `${title} is calling you.`, icon:"/assets/icons/cunnact-192.png", badge:"/assets/icons/cunnact-32.png" });
      }
    } catch {}
  }

  function removeRemoteVideo(uid) {
    document.querySelector(`[data-remote-video="${CSS.escape(uid)}"]`)?.remove();
  }

  function addRemoteVideo(uid, stream) {
    const grid = document.getElementById("remoteCallVideos");
    if (!grid) return;
    let wrap = grid.querySelector(`[data-remote-video="${CSS.escape(uid)}"]`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "remote-video-card";
      wrap.dataset.remoteVideo = uid;
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("aria-label", "Remote call video");
      wrap.appendChild(video);
      const label = document.createElement("span");
      label.className = "remote-video-label";
      label.textContent = "Participant";
      wrap.appendChild(label);
      grid.appendChild(wrap);
    }
    const video = wrap.querySelector("video");
    if (video && video.srcObject !== stream) video.srcObject = stream;
    document.getElementById("callStagePlaceholder")?.setAttribute("hidden", "true");
  }

  async function getMedia(callType) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("MEDIA_UNSUPPORTED");
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: callType === "video" ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false });
  }

  async function startLocalMedia(session) {
    session.localStream = await getMedia(session.callType);
    const localVideo = document.getElementById("localCallVideo");
    if (localVideo) {
      localVideo.srcObject = session.localStream;
      localVideo.muted = true;
      localVideo.playsInline = true;
      localVideo.autoplay = true;
      localVideo.hidden = session.callType !== "video";
    }
  }

  async function writeCandidate(callId, remoteUid, candidate) {
    if (!candidate) return;
    const peerId = pairKey(user().uid, remoteUid);
    await addDoc(collection(db, "conversations", state.current.conversationId, "calls", callId, "peers", peerId, "candidates"), {
      senderId: user().uid,
      candidate: safeJson(candidate),
      createdAt: serverTimestamp()
    });
  }

  async function ensurePeer(session, remoteUid) {
    if (remoteUid === user().uid) return null;
    if (session.peers.has(remoteUid)) return session.peers.get(remoteUid).pc;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const record = { pc, pendingCandidates: [], candidateUnsub: null, peerUnsub: null, remoteDescriptionSet: false, startedOffer: false };
    session.peers.set(remoteUid, record);

    session.localStream?.getTracks().forEach(track => pc.addTrack(track, session.localStream));
    pc.ontrack = (event) => addRemoteVideo(remoteUid, event.streams?.[0] || new MediaStream([event.track]));
    pc.onicecandidate = (event) => {
      if (event.candidate) writeCandidate(session.callId, remoteUid, event.candidate).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        removeRemoteVideo(remoteUid);
      }
    };

    const peerRef = doc(db, "conversations", session.conversationId, "calls", session.callId, "peers", pairKey(user().uid, remoteUid));
    record.peerUnsub = onSnapshot(peerRef, async snap => {
      if (!snap.exists() || state.current !== session) return;
      const data = snap.data() || {};
      try {
        const weOffer = user().uid < remoteUid;
        if (weOffer && !record.startedOffer && !data.offer) {
          record.startedOffer = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await setDoc(peerRef, { from: user().uid, to: remoteUid, offer: safeJson(offer), updatedAt: serverTimestamp() }, { merge: true });
        }
        if (!weOffer && data.offer && !record.remoteDescriptionSet) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          record.remoteDescriptionSet = true;
          for (const candidate of record.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await setDoc(peerRef, { from: user().uid, to: remoteUid, answer: safeJson(answer), updatedAt: serverTimestamp() }, { merge: true });
        }
        if (weOffer && data.answer && !record.remoteDescriptionSet) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          record.remoteDescriptionSet = true;
          for (const candidate of record.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        }
      } catch (error) {
        console.warn("Peer signaling failed", error);
      }
    });

    record.candidateUnsub = onSnapshot(collection(db, "conversations", session.conversationId, "calls", session.callId, "peers", pairKey(user().uid, remoteUid), "candidates"), snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== "added") return;
        const item = change.doc.data();
        if (item.senderId === user().uid || !item.candidate) return;
        const candidate = new RTCIceCandidate(item.candidate);
        if (record.remoteDescriptionSet) pc.addIceCandidate(candidate).catch(() => {});
        else record.pendingCandidates.push(candidate);
      });
    }, () => {});
    return pc;
  }

  async function connectPeers(session) {
    const remotes = session.participantIds.filter(uid => uid !== user().uid);
    for (const remoteUid of remotes) await ensurePeer(session, remoteUid);
  }

  async function joinCall(call, { isInitiator = false, preloadedStream = null } = {}) {
    if (!user() || !call?.id) return false;
    if (state.current) {
      showToast("You're already in a call.", "info");
      return false;
    }
    const conv = getConversations?.().find(c => c.id === call.conversationId);
    if (!conv || !conv.members?.includes(user().uid)) {
      showToast("You don't have access to this call.", "error");
      return false;
    }
    if (!call.participantIds?.includes(user().uid)) {
      showToast("This call is not available to your account.", "error");
      return false;
    }
    try {
      state.current = {
        callId: call.id,
        conversationId: call.conversationId,
        callType: call.callType || "voice",
        participantIds: call.participantIds.slice(0, 12),
        isInitiator: !!isInitiator,
        peers: new Map(),
        localStream: null,
        call,
        callDocUnsub: null,
        connectedAt: null
      };
      state.incoming = null;
      state.current.callDocUnsub = onSnapshot(doc(db, "conversations", call.conversationId, "calls", call.id), snap => {
        const latest = snap.exists() ? { id: snap.id, ...snap.data() } : null;
        if (!latest || state.current?.callId !== call.id) return;
        state.current.call = latest;
        const reaction = latest.callReaction;
        const reactionEl = document.getElementById("callReactionStatus");
        if (reactionEl) reactionEl.textContent = reaction ? `${reaction}` : "";
        const handEl = document.getElementById("callRaiseHandBtn");
        if (handEl) { const label=handEl.querySelector?.(".call-control-label"); const active=(latest.raisedHands || []).includes(user().uid); if(label) label.textContent = active ? "Lower" : "Hand"; else handEl.textContent = active ? "Lower hand" : "Raise hand"; }
        if (latest.status === "active" && !state.current.connectedAt) {
          setCallUi(latest, "active");
          startDurationTimer();
          document.getElementById("callStageHint")?.replaceChildren(document.createTextNode(latest.callType === "video" ? "Video call" : "Voice call"));
        }
        if (latest.status === "declined") {
          setCallUi(latest, "declined");
          showToast("The call was declined.", "info");
          setTimeout(() => cleanupCall(false).catch(() => {}), 450);
        }
        if (latest.status === "ended" && state.current) cleanupCall(false).catch(() => {});
      }, () => {});
      closeModal("incomingCallModal");
      openModal("activeCallModal");
      setCallUi(call, "connecting");
      if (preloadedStream) {
        state.current.localStream = preloadedStream;
        const localVideo = document.getElementById("localCallVideo");
        if (localVideo) { localVideo.srcObject = preloadedStream; localVideo.hidden = state.current.callType !== "video"; }
      } else {
        await startLocalMedia(state.current);
      }
      await updateDoc(doc(db, "conversations", call.conversationId, "calls", call.id), {
        status: isInitiator ? "ringing" : "active",
        joinedParticipantIds: arrayUnion(user().uid),
        activeParticipantIds: arrayUnion(user().uid),
        updatedAt: serverTimestamp()
      });
      await connectPeers(state.current);
      setCallUi(call, isInitiator ? "ringing" : "active");
      if (!isInitiator) startDurationTimer();
      if (isInitiator) {
        clearRingTimer();
        state.ringTimer = setTimeout(() => {
          if (state.current?.callId !== call.id) return;
          showToast("No answer. You can call again later.", "info");
          cleanupCall(true).catch(() => {});
        }, 60000);
      }
      return true;
    } catch (error) {
      console.error("Call join failed", error);
      await cleanupCall(false);
      const msg = error?.name === "NotAllowedError" ? "Microphone/camera permission was denied." : "Could not join the call.";
      showToast(msg, "error");
      return false;
    }
  }

  async function startCall({ conversationId, participantIds, callType = "voice", title = "", type = "direct" } = {}) {
    if (!user() || !conversationId) return false;
    if (state.current) {
      showToast("You're already in a call.", "info");
      return false;
    }
    const ids = [...new Set([user().uid, ...(participantIds || [])].filter(Boolean))];
    if (type === "direct" && ids.length !== 2) return false;
    if (ids.length > 8) {
      showToast("Group calls currently support up to 8 participants.", "info");
      return false;
    }
    if (ids.length < 2) {
      showToast("Add another participant before starting a call.", "info");
      return false;
    }
    let preloadedStream = null;
    try {
      preloadedStream = await getMedia(callType);
    } catch (mediaError) {
      const msg = mediaError?.name === "NotAllowedError" ? `Allow microphone${callType === "video" ? " and camera" : ""} access to place this call.` : "Your browser could not access the required call device.";
      showToast(msg, "error");
      return false;
    }
    const ref = doc(collection(db, "conversations", conversationId, "calls"));
    const call = {
      conversationId,
      type,
      callType,
      title: title || (type === "group" ? "Group call" : "Voice / video call"),
      initiatorId: user().uid,
      participantIds: ids,
      joinedParticipantIds: [user().uid],
      activeParticipantIds: [user().uid],
      status: "ringing",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    try {
      await setDoc(ref, call);
      return joinCall({ id: ref.id, ...call, createdAt: new Date() }, { isInitiator: true, preloadedStream });
    } catch (error) {
      preloadedStream?.getTracks?.().forEach(track => track.stop());
      console.error("Call start failed", error);
      showToast(error?.code === "permission-denied" ? "Firebase blocked call creation. Deploy the latest firestore.rules." : "Could not start the call.", "error");
      return false;
    }
  }

  async function declineIncoming() {
    const call = state.incoming;
    state.incoming = null;
    closeModal("incomingCallModal");
    if (!call || !user()) return;
    try {
      if (call.type === "direct") {
        await updateDoc(doc(db, "conversations", call.conversationId, "calls", call.id), { status: "declined", declinedBy: arrayUnion(user().uid), updatedAt: serverTimestamp() });
      } else {
        await updateDoc(doc(db, "conversations", call.conversationId, "calls", call.id), { declinedBy: arrayUnion(user().uid), updatedAt: serverTimestamp() });
      }
    } catch {}
  }

  async function cleanupCall(endWholeCall = true) {
    const session = state.current;
    if (!session) return;
    clearRingTimer();
    stopDurationTimer();
    session.callDocUnsub?.();
    for (const record of session.peers.values()) {
      record.peerUnsub?.();
      record.candidateUnsub?.();
      try { record.pc.close(); } catch {}
    }
    session.peers.clear();
    session.localStream?.getTracks().forEach(track => track.stop());
    const localVideo = document.getElementById("localCallVideo");
    if (localVideo) localVideo.srcObject = null;
    document.getElementById("remoteCallVideos")?.replaceChildren();
    try {
      const ref = doc(db, "conversations", session.conversationId, "calls", session.callId);
      if (endWholeCall) {
        await updateDoc(ref, { status: "ended", endedAt: serverTimestamp(), endedBy: user().uid, activeParticipantIds: [] }).catch(() => {});
      } else {
        await updateDoc(ref, { activeParticipantIds: arrayRemove(user().uid), [`leftAt.${user().uid}`]: serverTimestamp() }).catch(() => {});
      }
    } catch {}
    state.current = null;
    closeModal("activeCallModal");
  }

  async function leaveCall() {
    const session = state.current;
    if (!session) return;
    if (session.isInitiator) await cleanupCall(true);
    else await cleanupCall(false);
  }

  async function toggleMute() {
    const stream = state.current?.localStream;
    const track = stream?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById("callMuteBtn");
    if (btn) { btn.textContent = track.enabled ? "Mute" : "Unmute"; btn.classList.toggle("is-off", !track.enabled); }
  }

  async function toggleVideo() {
    const stream = state.current?.localStream;
    const track = stream?.getVideoTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById("callVideoBtn");
    if (btn) { const label=btn.querySelector?.(".call-control-label"); if(label) label.textContent = track.enabled ? "Camera" : "Camera off"; else btn.textContent = track.enabled ? "Camera" : "Camera off"; btn.classList.toggle("is-off", !track.enabled); }
  }

  async function toggleScreenShare() {
    const session = state.current;
    if (!session || !navigator.mediaDevices?.getDisplayMedia) {
      showToast("Screen sharing is not supported here.", "info");
      return;
    }
    if (session.screenStream) {
      const oldTrack = session.localStream?.getVideoTracks?.()[0];
      const screenTrack = session.screenStream.getVideoTracks()[0];
      for (const record of session.peers.values()) {
        const sender = record.pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(oldTrack || null);
      }
      screenTrack.stop(); session.screenStream = null;
      return;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      session.screenStream = screen;
      const track = screen.getVideoTracks()[0];
      for (const record of session.peers.values()) {
        const sender = record.pc.getSenders().find(s => s.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
      }
      track.onended = () => toggleScreenShare().catch(() => {});
    } catch (e) {
      if (e?.name !== "AbortError") showToast("Screen sharing could not start.", "error");
    }
  }

  async function toggleRaiseHand() {
    const session = state.current;if(!session)return;
    const raised=(session.call?.raisedHands||[]).includes(user().uid);
    try{await updateDoc(doc(db,"conversations",session.conversationId,"calls",session.callId),{raisedHands:raised?[]:arrayUnion(user().uid),updatedAt:serverTimestamp()});}catch(e){showToast("Could not update your hand.","error");}
  }
  async function sendCallReaction() {
    const session=state.current;if(!session)return;
    const reactions=["❤️","😂","👏","🔥","😮"];
    const current=session.call?.callReaction;const next=reactions[(reactions.indexOf(current)+1)%reactions.length];
    try{await updateDoc(doc(db,"conversations",session.conversationId,"calls",session.callId),{callReaction:next,updatedAt:serverTimestamp()});}catch(e){showToast("Could not send reaction.","error");}
  }
  async function enterPip() {
    const video=document.getElementById("localCallVideo")?.hidden?document.querySelector("#remoteCallVideos video"):document.getElementById("localCallVideo");
    if(!video?.requestPictureInPicture){showToast("Picture-in-picture is not supported here.","info");return;}
    try{await video.requestPictureInPicture();}catch{showToast("Picture-in-picture could not start.","error");}
  }

  async function copyCallLink() {
    const session = state.current;
    if (!session) return;
    const url = new URL(location.href);
    url.searchParams.set("call", session.callId);
    url.searchParams.set("conversation", session.conversationId);
    try { await navigator.clipboard.writeText(url.href); showToast("Call link copied", "success"); }
    catch { showToast("Could not copy the call link.", "error"); }
  }

  function syncConversationListeners(conversations = []) {
    const wanted = new Set(conversations.map(c => c.id));
    for (const [id, unsub] of state.listeners) {
      if (!wanted.has(id)) { unsub(); state.listeners.delete(id); }
    }
    conversations.forEach(c => {
      if (state.listeners.has(c.id)) return;
      const unsub = onSnapshot(query(collection(db, "conversations", c.id, "calls"), limit(20)), snap => {
        snap.docChanges().forEach(change => {
          if (!change.doc.exists() || !["added", "modified"].includes(change.type)) return;
          const call = { id: change.doc.id, ...change.doc.data() };
          if (!call.participantIds?.includes(user()?.uid)) return;
          if (state.incoming?.callId === call.id && !["ringing", "active"].includes(call.status)) {
            state.incoming = null;
            closeModal("incomingCallModal");
          }
          if (["ringing", "active"].includes(call.status) && call.initiatorId !== user()?.uid && !state.current && !state.incoming) showIncoming(call);
        });
      }, () => {});
      state.listeners.set(c.id, unsub);
    });
  }

  async function consumeCallLink() {
    const params = new URLSearchParams(location.search);
    const callId = params.get("call");
    const conversationId = params.get("conversation");
    if (!callId || !conversationId || !user()) return;
    try {
      const snap = await getDoc(doc(db, "conversations", conversationId, "calls", callId));
      if (!snap.exists()) throw new Error("CALL_NOT_FOUND");
      const call = { id: snap.id, ...snap.data() };
      if (!call.participantIds?.includes(user().uid)) throw new Error("CALL_NOT_ALLOWED");
      await joinCall(call, { isInitiator: call.initiatorId === user().uid });
      const clean = new URL(location.href); clean.searchParams.delete("call"); clean.searchParams.delete("conversation"); history.replaceState({}, "", clean.toString());
    } catch (error) {
      console.warn("Call link failed", error);
      showToast("This call link is unavailable or expired.", "error");
    }
  }

  async function showHistory(conversationId) {
    const box = document.getElementById("callHistoryList");
    if (!box) return;
    state.callHistoryConversationId = conversationId;
    box.innerHTML = '<div class="empty-state">Loading call history…</div>';
    try {
      const snap = await new Promise((resolve, reject) => {
        const unsub = onSnapshot(query(collection(db, "conversations", conversationId, "calls"), limit(30)), s => { unsub(); resolve(s); }, reject);
      });
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      box.innerHTML = rows.length ? rows.map(call => `<div class="call-history-row"><span class="call-history-icon">${call.callType === "video" ? "🎥" : "📞"}</span><span class="meta"><strong>${escapeHtmlLocal(call.title || (call.type === "group" ? "Group call" : "Voice call"))}</strong><small>${call.status || "unknown"} · ${call.createdAt?.toDate ? call.createdAt.toDate().toLocaleString() : ""}</small></span></div>`).join("") : '<div class="empty-state">No calls in this conversation yet.</div>';
    } catch (e) {
      box.innerHTML = '<div class="empty-state">Call history could not be loaded.</div>';
    }
    openModal("callHistoryModal");
  }
  function escapeHtmlLocal(value) { return String(value ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

  document.getElementById("incomingCallAcceptBtn")?.addEventListener("click", () => { const call = state.incoming; if (call) joinCall(call); });
  document.getElementById("incomingCallDeclineBtn")?.addEventListener("click", declineIncoming);
  document.getElementById("callEndBtn")?.addEventListener("click", leaveCall);
  document.getElementById("callMuteBtn")?.addEventListener("click", toggleMute);
  document.getElementById("callVideoBtn")?.addEventListener("click", toggleVideo);
  document.getElementById("callScreenShareBtn")?.addEventListener("click", toggleScreenShare);
  document.getElementById("callShareLinkBtn")?.addEventListener("click", copyCallLink);
  document.getElementById("callReactBtn")?.addEventListener("click", sendCallReaction);
  document.getElementById("callRaiseHandBtn")?.addEventListener("click", toggleRaiseHand);
  document.getElementById("callPipBtn")?.addEventListener("click", enterPip);

  return {
    startCall,
    joinCall,
    declineIncoming,
    leaveCall,
    syncConversationListeners,
    consumeCallLink,
    showHistory,
    getCurrentCall: () => state.current,
    teardown: () => { state.listeners.forEach(unsub => unsub()); state.listeners.clear(); cleanupCall(true); }
  };
}
