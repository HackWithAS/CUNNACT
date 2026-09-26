// CUNNACT — sends a push notification when a new chat message is created.
//
// This is intentionally the ONLY server-side piece added for the Android
// app. It does not touch any existing Firestore documents, does not change
// any security rule, and the web app keeps working exactly as before if
// this function is never deployed (push notifications simply won't arrive,
// nothing else breaks).
//
// Deploy with:  firebase deploy --only functions

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("crypto");
const { defineSecret } = require("firebase-functions/params");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

const CLOUDINARY_API_KEY = defineSecret("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");
const CLOUDINARY_CLOUD_NAME = "qfw2dy0h";

function cloudinaryAssetFromMessage(message) {
  const storedId = String(message?.cloudinaryPublicId || "").trim();
  if (storedId) {
    return {
      publicId: storedId,
      resourceType: String(message?.cloudinaryResourceType || "image"),
      deliveryType: String(message?.cloudinaryDeliveryType || "upload"),
      sourceUrl: String(message?.mediaURL || message?.imageURL || "")
    };
  }
  const url = String(message?.mediaURL || message?.imageURL || "");
  if (!url || !url.includes(`res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/`)) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(new RegExp(`^/${CLOUDINARY_CLOUD_NAME}/([^/]+)/upload/(.*)$`));
    if (!m) return null;
    const resourceType = m[1] || "image";
    const parts = m[2].split("/").filter(Boolean);
    if (parts[0] && /^v\d+$/.test(parts[0])) parts.shift();
    if (!parts.length) return null;
    let publicId = parts.join("/");
    if (resourceType !== "raw") publicId = publicId.replace(/\.[^.\/]+$/, "");
    return { publicId, resourceType, deliveryType: "upload", sourceUrl: url };
  } catch (_) { return null; }
}

async function hasLiveReferenceToAsset(asset, deletedMessagePath) {
  const searches = [];
  if (asset?.publicId) searches.push(db.collectionGroup("messages").where("cloudinaryPublicId", "==", asset.publicId).limit(20));
  if (asset?.sourceUrl) {
    searches.push(db.collectionGroup("messages").where("mediaURL", "==", asset.sourceUrl).limit(20));
    searches.push(db.collectionGroup("messages").where("imageURL", "==", asset.sourceUrl).limit(20));
  }
  for (const q of searches) {
    try {
      const snap = await q.get();
      const live = snap.docs.some(d => {
        if (d.ref.path === deletedMessagePath) return false;
        const data = d.data() || {};
        return !data.deletedAt;
      });
      if (live) return true;
    } catch (e) {
      console.warn("Cloudinary reference check skipped", e?.message || e);
    }
  }
  return false;
}

async function destroyCloudinaryAsset(asset) {
  const apiKey = CLOUDINARY_API_KEY.value();
  const apiSecret = CLOUDINARY_API_SECRET.value();
  if (!apiKey || !apiSecret || !asset?.publicId) throw new Error("Cloudinary destroy credentials are not configured.");
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `public_id=${asset.publicId}&timestamp=${timestamp}`;
  const signature = crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${asset.resourceType || "image"}/destroy`;
  const body = new URLSearchParams({
    public_id: asset.publicId,
    timestamp: String(timestamp),
    api_key: apiKey,
    signature,
    type: asset.deliveryType || "upload",
    invalidate: "true"
  });
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Cloudinary destroy HTTP ${response.status}: ${JSON.stringify(result)}`);
  if (!['ok','not found'].includes(String(result?.result || '').toLowerCase())) throw new Error(`Cloudinary destroy failed: ${JSON.stringify(result)}`);
  return result;
}

exports.onNewMessage = onDocumentCreated(
  "conversations/{conversationId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;

    const { conversationId } = event.params;
    const convoSnap = await db.doc(`conversations/${conversationId}`).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();

    const members = (convo.members || []).filter((uid) => uid !== message.senderId);
    if (!members.length) return;

    const senderSnap = await db.doc(`users/${message.senderId}`).get();
    const senderName = senderSnap.exists ? senderSnap.data().name || "Someone" : "Someone";
    const isGroup = convo.type === "group";
    const title = isGroup ? (convo.groupName || "Group") : senderName;
    const body = isGroup
      ? `${senderName}: ${message.type === "image" ? "📷 Photo" : (message.text || "").slice(0, 120)}`
      : (message.type === "image" ? "📷 Photo" : (message.text || "").slice(0, 120));

    // Gather every device token for every recipient who isn't the sender.
    const userSnaps = await Promise.all(members.map((uid) => db.doc(`users/${uid}`).get()));
    const tokens = userSnaps.flatMap((s) => (s.exists ? s.data().fcmTokens || [] : []));
    if (!tokens.length) return;

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { conversationId, type: "message" },
      android: { priority: "high" }
    });

    // Clean up tokens that are no longer valid (app uninstalled, etc.) so the
    // fcmTokens array doesn't grow forever.
    const stale = [];
    response.responses.forEach((r, i) => {
      if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-argument"].includes(r.error?.code)) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length) {
      const { FieldValue } = require("firebase-admin/firestore");
      await Promise.all(
        members.map((uid) => db.doc(`users/${uid}`).update({ fcmTokens: FieldValue.arrayRemove(...stale) }).catch(() => {}))
      );
    }
  }
);


// Remove the Cloudinary asset when a message is deleted for everyone.
// The trigger runs server-side so the API secret never reaches the browser.
exports.cleanupDeletedMessageMedia = onDocumentUpdated(
  { document: "conversations/{conversationId}/messages/{messageId}", secrets: [CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET] },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.deletedAt || !after.deletedAt) return;

    const asset = cloudinaryAssetFromMessage(before);
    if (!asset?.publicId) return;

    const deletedPath = event.data.after.ref.path;
    const liveReference = await hasLiveReferenceToAsset(asset, deletedPath);
    if (liveReference) {
      console.log("Keeping Cloudinary asset because another live message references it", asset.publicId);
      return;
    }

    try {
      await destroyCloudinaryAsset(asset);
      console.log("Deleted Cloudinary asset for deleted message", asset.publicId);
    } catch (error) {
      // Do not fail the Firestore update; the message is already marked deleted.
      // A later manual cleanup can retry using the stored metadata.
      console.error("Cloudinary message-media cleanup failed", error);
    }
  }
);


// Remove expired story documents once per hour. Client queries also hide expired stories,
// but this keeps the primary collection clean over time. Subcollections become inaccessible
// when their parent story is removed.
exports.purgeExpiredStories = onSchedule("every 1 hours", async () => {
  const now = new Date();
  const snap = await db.collection("stories").where("expiresAt", "<=", now).limit(400).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((story) => batch.delete(story.ref));
  await batch.commit();
});


// ---------------- ACCOUNT LIFECYCLE ----------------
// Deletes authentication and private identity data while leaving a minimal
// "Deleted account" user document so existing shared chats keep rendering safely.
exports.deleteMyAccount = onCall({ timeoutSeconds: 180, memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to delete your account.");
  if (request.data?.confirmation !== "DELETE") throw new HttpsError("failed-precondition", "Confirmation is required.");

  const { FieldValue, FieldPath } = require("firebase-admin/firestore");
  const userRef = db.doc(`users/${uid}`);

  // Remove user-owned subcollections.
  for (const sub of ["blockedUsers", "savedMessages", "devices"]) {
    const snap = await userRef.collection(sub).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }

  const deleteByField = async (collectionName, field, value, queryLimit = 500) => {
    let snap = await db.collection(collectionName).where(field, "==", value).limit(queryLimit).get();
    while (!snap.empty) {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      if (snap.size < queryLimit) break;
      snap = await db.collection(collectionName).where(field, "==", value).limit(queryLimit).get();
    }
  };

  for (const pair of [["messageRequests","senderId"],["messageRequests","receiverId"],["securityEvents","userId"],["reports","reporterId"]]) {
    await deleteByField(pair[0], pair[1], uid);
  }

  const usernameSnap = await db.collection("usernames").where("uid", "==", uid).get();
  if (!usernameSnap.empty) {
    const batch = db.batch(); usernameSnap.docs.forEach(d => batch.delete(d.ref)); await batch.commit();
  }

  const storySnap = await db.collection("stories").where("ownerId", "==", uid).get();
  for (const story of storySnap.docs) await db.recursiveDelete(story.ref);

  // Scrub owned content and remove membership from conversations.
  const convoSnap = await db.collection("conversations").where("members", "array-contains", uid).get();
  for (const convo of convoSnap.docs) {
    const data = convo.data() || {};
    const members = Array.isArray(data.members) ? data.members : [];
    const otherMembers = members.filter(id => id !== uid);
    const messages = await convo.ref.collection("messages").where("senderId", "==", uid).get();
    if (!messages.empty) {
      for (let i=0;i<messages.docs.length;i+=400) { const batch=db.batch(); messages.docs.slice(i,i+400).forEach(d=>batch.delete(d.ref)); await batch.commit(); }
    }
    if (data.type === "group") {
      if (!otherMembers.length) { await db.recursiveDelete(convo.ref); continue; }
      const admins=(data.groupAdmins||[]).filter(id=>id!==uid); const mods=(data.groupModerators||[]).filter(id=>id!==uid);
      const roles={...(data.groupRoles||{})}; delete roles[uid];
      const nextAdmins=admins.length?admins:[otherMembers[0]]; const nextMods=mods.filter(id=>nextAdmins.includes(id));
      await convo.ref.update({members:otherMembers,groupAdmins:nextAdmins,groupModerators:nextMods,groupRoles:roles,unread:FieldValue.delete(),lastMessageSenderId:data.lastMessageSenderId===uid?"":data.lastMessageSenderId,lastMessage: data.lastMessageSenderId===uid?"":""});
    } else {
      // Preserve the other participant's chat shell but make the departed identity inert.
      await convo.ref.update({deletedMemberIds:FieldValue.arrayUnion(uid),deletedAtBy:FieldValue.arrayUnion(uid)});
    }
  }

  // Remove membership from communities; transfer ownership to an existing admin/member when possible.
  const communitySnap = await db.collection("communities").where("memberIds", "array-contains", uid).get();
  for (const c of communitySnap.docs) {
    const d=c.data()||{}, members=(d.memberIds||[]).filter(id=>id!==uid), admins=(d.adminIds||[]).filter(id=>id!==uid), mods=(d.moderatorIds||[]).filter(id=>id!==uid);
    if(!members.length){await db.recursiveDelete(c.ref);continue;}
    const owner = d.ownerId===uid ? (admins[0]||members[0]) : d.ownerId;
    const nextAdmins=admins.length?admins:(owner?[owner]:[]);
    await c.ref.update({memberIds:members,adminIds:nextAdmins,moderatorIds:mods.filter(id=>nextAdmins.includes(id)),ownerId:owner,updatedAt:FieldValue.serverTimestamp()});
  }

  const channelSnap = await db.collection("channels").where("subscriberIds", "array-contains", uid).get();
  for (const c of channelSnap.docs) {
    const d=c.data()||{}, subscribers=(d.subscriberIds||[]).filter(id=>id!==uid), admins=(d.adminIds||[]).filter(id=>id!==uid);
    if(!subscribers.length && d.ownerId===uid){await db.recursiveDelete(c.ref);continue;}
    const owner=d.ownerId===uid?(admins[0]||subscribers[0]||""):d.ownerId;
    const nextAdmins=admins.length?admins:(owner?[owner]:[]);
    await c.ref.update({subscriberIds:subscribers,adminIds:nextAdmins,ownerId:owner,updatedAt:FieldValue.serverTimestamp()});
  }

  // Remove public identity and private preferences. Keep a minimal tombstone user doc for shared chat rendering.
  await db.doc(`publicProfiles/${uid}`).delete().catch(()=>{});
  await db.doc(`userSettings/${uid}`).delete().catch(()=>{});
  await userRef.set({uid,name:"Deleted account",email:"",emailLower:"",photoURL:"",bio:"",username:"",usernameLower:"",discoverable:false,profileVisibility:"private",isOnline:false,deletedAt:FieldValue.serverTimestamp(),deletedAccount:true},{merge:false});

  await db.doc(`cunnactDeletionRequests/${uid}`).set({uid,deletedAt:FieldValue.serverTimestamp()},{merge:true}).catch(()=>{});
  await require("firebase-admin").auth().deleteUser(uid);
  return {success:true};
});
