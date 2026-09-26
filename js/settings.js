import {
  auth, db, functions, httpsCallable, onAuthStateChanged, updateProfile, doc, getDoc, getDocs, setDoc,
  updateDoc, deleteDoc, serverTimestamp, runTransaction, multiFactor, RecaptchaVerifier, collection, query, where, orderBy, limit,
  PhoneAuthProvider, PhoneMultiFactorGenerator, EmailAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup, GoogleAuthProvider
} from "./firebase.js";
import { uploadImageToCloudinary, UploadError } from "./cloudinary.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";
import { $, debounce } from "./ui.js";
import { isSoundEnabled, setSoundEnabled, playClick, playSuccess } from "./sound.js";
import { getRetentionMode, loadRetentionMode, setRetentionMode, setUserSetting } from "./retention.js";
import { createPinHash, listDevices, revokeDevice, revokeOtherDevices, getDeviceSessionId, writeSecurityEvent } from "./security.js";
import { enablePushNotifications, disablePushNotifications, notificationsAreEnabled, loadNotificationSettings, getNotificationSettings, saveNotificationSettings, notifyBrowser } from "./notifications.js";
import { bindAccountTools } from "./account.js";

let currentUser = null;
let currentPhotoURL = "";
let original = {};
let usernameToken = 0;
let uploadController = null;
let pendingTheme = localStorage.getItem("cunnact_theme") || "light";
let profileSettings = {};
let currentUserData = {};
let recaptchaVerifier = null;
let mfaVerificationId = null;
let mfaUser = null;
const RESERVED = new Set(["admin","administrator","support","help","cunnact","official","security","system","root","api","www","user","users","profile","login","register","settings"]);
const PATTERN = /^[a-z0-9_]{3,24}$/;

const normalizeUsername = (value) => String(value || "").trim().replace(/^@+/, "").toLowerCase();
const suggestedUsername = (name, email) => {
  const raw = (String(name || "") || String(email || "").split("@")[0]).toLowerCase().replace(/[^a-z0-9_]/g, "");
  return raw.slice(0,24) || "cunnacter";
};
function setStatus(text="", type="") { const el=$("profileMessage"); if(el){el.textContent=text;el.className=`profile-status ${type}`.trim();} }
function escapeHtml(value){return String(value??"").replace(/[&<>"\']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\'":"&#039;"}[ch]));}
function updateBioCount(){const b=$("profileBio"),c=$("bioCount");if(b&&c)c.textContent=String(b.value.length);}
function updatePreview(){const name=$("profileName")?.value.trim()||"Your name", u=normalizeUsername($("profileUsername")?.value)||"username";$("heroDisplayName")?.textContent=name;$("heroUsername")?.textContent=`@${u}`;$("publicProfileState")?.textContent=`@${u}`;}
async function usernameAvailable(value){
  const username=normalizeUsername(value),status=$("usernameStatus");
  if(!username){status.textContent="Choose a unique ID to share your profile.";status.className="";return false;}
  if(!PATTERN.test(username)){status.textContent="Use 3–24 lowercase letters, numbers or underscores.";status.className="error";return false;}
  if(RESERVED.has(username)){status.textContent="That CUNNACT ID is reserved.";status.className="error";return false;}
  const token=++usernameToken;status.textContent="Checking availability…";status.className="";
  try{const snap=await getDoc(doc(db,"usernames",username));if(token!==usernameToken)return false;const free=!snap.exists()||snap.data()?.uid===currentUser?.uid;status.textContent=free?"✓ Available":"✕ Username already taken";status.className=free?"success":"error";return free;}
  catch(e){console.error(e);if(token===usernameToken){status.textContent="Could not check availability.";status.className="error";}return false;}
}
async function claimUsername(nextValue,oldValue,name,bio,photoURL){
  const next=normalizeUsername(nextValue),old=normalizeUsername(oldValue);
  if(!PATTERN.test(next)||RESERVED.has(next))throw new Error("INVALID_USERNAME");
  await runTransaction(db,async(tx)=>{
    const nextRef=doc(db,"usernames",next),oldRef=old&&old!==next?doc(db,"usernames",old):null,userRef=doc(db,"users",currentUser.uid),publicRef=doc(db,"publicProfiles",currentUser.uid);
    const nextSnap=await tx.get(nextRef);
    if(nextSnap.exists()&&nextSnap.data()?.uid!==currentUser.uid)throw new Error("USERNAME_TAKEN");
    tx.set(nextRef,{uid:currentUser.uid,createdAt:nextSnap.exists()?nextSnap.data()?.createdAt:serverTimestamp()},{merge:true});
    if(oldRef){const oldSnap=await tx.get(oldRef);if(oldSnap.exists()&&oldSnap.data()?.uid===currentUser.uid)tx.delete(oldRef);}
    tx.set(userRef,{username:next,usernameLower:next,name,photoURL,bio},{merge:true});
    tx.set(publicRef,{uid:currentUser.uid,username:next,usernameLower:next,displayName:name,photoURL,bio,updatedAt:serverTimestamp()},{merge:true});
  });
}
async function savePublicProfile(name,bio,username){await setDoc(doc(db,"publicProfiles",currentUser.uid),{uid:currentUser.uid,username,usernameLower:username,displayName:name,displayNameLower:String(name||"").toLowerCase(),photoURL:currentPhotoURL||"",bio,updatedAt:serverTimestamp()},{merge:true});}
function resolveThemeLocal(pref){if(pref==="dark")return "dark";if(pref==="system")return (window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";return "light";}
function applyLocalTheme(theme){const t=(theme==="dark"||theme==="system")?theme:"light";pendingTheme=t;document.documentElement.dataset.theme=resolveThemeLocal(t);localStorage.setItem("cunnact_theme",t);document.querySelectorAll('input[name="themeMode"]').forEach(r=>{r.checked=(r.value===t);});}

onAuthStateChanged(auth,async(user)=>{
  if(!user){location.replace("login.html");return;}
  currentUser=user;
  try{
    const userSnap=await getDoc(doc(db,"users",user.uid)), data=userSnap.exists()?userSnap.data():{};
    const settingsSnap=await getDoc(doc(db,"userSettings",user.uid)), settings=settingsSnap.exists()?settingsSnap.data():{};
    profileSettings=settings;
    currentUserData = data || {};
    const name=data.name||user.displayName||user.email||"User", username=normalizeUsername(data.username||""), bio=data.bio||"";
    currentPhotoURL=data.photoURL||user.photoURL||"";pendingTheme=settings.theme||localStorage.getItem("cunnact_theme")||"light";applyLocalTheme(pendingTheme);
    original={name,username,bio,photoURL:currentPhotoURL,retention:settings.retentionMode||"24hours",sound:settings.soundEnabled!==false,theme:pendingTheme};
    $("profileName").value=name;$("profileEmail").value=user.email||data.email||"";$("profileUsername").value=username;$("profileBio").value=bio;if(!username)$("profileUsername").placeholder=suggestedUsername(name,user.email);
    updateBioCount();updatePreview();paintAvatar($("profileAvatar"),{photoURL:currentPhotoURL,name,email:user.email});
    const retention=await loadRetentionMode(user.uid);const retentionRadio=document.querySelector(`input[name="retention"][value="${retention}"]`); if(retentionRadio) retentionRadio.checked=true;
    $("settingsSoundToggle").checked=settings.soundEnabled!==false;
    if($("lastSeenToggle"))$("lastSeenToggle").checked=!data.hideLastSeen;
    if($("readReceiptsToggle"))$("readReceiptsToggle").checked=settings.showReadReceipts!==false;
    if($("typingIndicatorsToggle"))$("typingIndicatorsToggle").checked=settings.showTypingIndicators!==false;
    if($("profileVisibility"))$("profileVisibility").value=data.profileVisibility||"public";
    if($("discoverableToggle"))$("discoverableToggle").checked=data.discoverable!==false;
    if($("appLockToggle"))$("appLockToggle").checked=!!settings.appLockEnabled;
    await updatePrivacySummaries();
    await refreshSecurityUI();
    bindAccountTools({userRef:()=>currentUser});
    await loadNotificationSettings(currentUser.uid);
    syncNotificationSettingsUI();
    window.CUNNACTSettings?.syncPreview?.();
    setStatus("");
  }catch(e){console.error("Profile load error",e);setStatus("Could not load your settings. Please refresh.","error");}
});

$("profileName")?.addEventListener("input",updatePreview);
$("profileBio")?.addEventListener("input",updateBioCount);
$("profileUsername")?.addEventListener("input",debounce(()=>{updatePreview();usernameAvailable($("profileUsername").value);},480));
const openPicker=()=>{$("photoInput")?.click();};
$("avatarButton")?.addEventListener("click",openPicker);$("changePhotoBtn")?.addEventListener("click",openPicker);
$("photoInput")?.addEventListener("change",async()=>{
  const file=$("photoInput").files?.[0];$("photoInput").value="";if(!file||!currentUser)return;
  uploadController?.abort();uploadController=new AbortController();const prev=currentPhotoURL, objectUrl=URL.createObjectURL(file),stage=$("profileAvatar")?.closest(".profile-hero-avatar");
  stage?.classList.add("uploading");paintAvatar($("profileAvatar"),{photoURL:objectUrl,name:$("profileName").value,email:currentUser.email});$("uploadStatus").textContent="Uploading photo…";
  try{const url=await uploadImageToCloudinary(file,{signal:uploadController.signal,onProgress:p=>$("uploadProgressFill").style.width=`${Math.round(p*100)}%`});currentPhotoURL=url;await updateProfile(currentUser,{photoURL:url});await updateDoc(doc(db,"users",currentUser.uid),{photoURL:url});const username=normalizeUsername($("profileUsername").value);if(username)await savePublicProfile($("profileName").value.trim(),$("profileBio").value.trim(),username);paintAvatar($("profileAvatar"),{photoURL:url,name:$("profileName").value,email:currentUser.email});$("uploadStatus").textContent="Profile photo updated ✓";playSuccess();showToast("Profile photo updated","success");}
  catch(e){if(e?.kind!=="aborted"){console.error(e);$("uploadStatus").textContent=e instanceof UploadError?e.userMessage:"Couldn't upload image.";paintAvatar($("profileAvatar"),{photoURL:prev,name:$("profileName").value,email:currentUser.email});showToast($("uploadStatus").textContent,"error");}}
  finally{URL.revokeObjectURL(objectUrl);stage?.classList.remove("uploading");setTimeout(()=>{$("uploadStatus").textContent="";$("uploadProgressFill").style.width="0%"},2200);}
});

document.querySelectorAll('input[name="retention"]').forEach(r=>r.addEventListener("change",async(e)=>{try{await setRetentionMode(e.target.value,currentUser.uid);showToast(e.target.value==="seen"?"Messages will remove after they're seen":"Messages will remove after 24 hours","success");}catch(err){console.error(err);showToast("Could not save retention setting","error");}}));
$("settingsSoundToggle")?.addEventListener("change",async(e)=>{const enabled=!!e.target.checked;setSoundEnabled(enabled);try{await setUserSetting(currentUser.uid,{soundEnabled:enabled});}catch(err){console.error(err);}if(enabled)playClick();});

function syncNotificationSettingsUI(){
  const s=getNotificationSettings();
  const map={
    notificationBannerToggle:s.banner, notificationBadgeToggle:s.badge, notificationMessagesToggle:s.messages,
    notificationGroupsToggle:s.groups, notificationStatusToggle:s.status, notificationCallsToggle:s.calls,
    notificationPreviewsToggle:s.previews, notificationOutgoingSoundToggle:s.outgoingSound
  };
  Object.entries(map).forEach(([id,value])=>{const el=$(id);if(el)el.checked=!!value;});
  const banner=$("notificationBannerSummary"); if(banner)banner.textContent=s.banner?"Always":"Off";
  const badge=$("notificationBadgeSummary"); if(badge)badge.textContent=s.badge?"Always":"Off";
  const status=$("browserNotificationStatus");
  const btn=$("browserNotificationsBtn");
  const enabled=notificationsAreEnabled();
  if(status)status.textContent=enabled?"Allowed on this browser. New CUNNACT notifications can appear outside the active tab.":("Notification permission is " + ((typeof Notification!=="undefined"&&Notification.permission)||"not available") + ".");
  if(btn){btn.textContent=enabled?"Disable":"Enable";btn.classList.toggle("is-enabled",enabled);}
}

const notificationControlMap={
  notificationBannerToggle:"banner", notificationBadgeToggle:"badge", notificationMessagesToggle:"messages",
  notificationGroupsToggle:"groups", notificationStatusToggle:"status", notificationCallsToggle:"calls",
  notificationPreviewsToggle:"previews", notificationOutgoingSoundToggle:"outgoingSound"
};
Object.entries(notificationControlMap).forEach(([id,key])=>{
  $(id)?.addEventListener("change",async(e)=>{
    if(!currentUser)return;
    try{await saveNotificationSettings(currentUser.uid,{[key]:!!e.target.checked});syncNotificationSettingsUI();showToast(`${key === "outgoingSound" ? "Outgoing message sound" : "Notification setting"} ${e.target.checked?"enabled":"disabled"}`,"success");}
    catch(err){console.error("Notification setting failed",err);e.target.checked=!e.target.checked;showToast("Could not save notification setting","error");}
  });
});

$("browserNotificationsBtn")?.addEventListener("click",async()=>{
  if(!currentUser)return;
  const btn=$("browserNotificationsBtn");
  btn.disabled=true;
  try{
    if(notificationsAreEnabled()){await disablePushNotifications(currentUser);showToast("Browser notifications disabled","success");}
    else{await enablePushNotifications(currentUser);showToast("Browser notifications enabled","success");}
  }catch(err){showToast(err?.message||"Could not update browser notifications.","error");}
  finally{btn.disabled=false;syncNotificationSettingsUI();}
});
$("testBrowserNotificationBtn")?.addEventListener("click",async()=>{
  if(!currentUser)return;
  try{
    if(!notificationsAreEnabled()){
      await enablePushNotifications(currentUser);
      syncNotificationSettingsUI();
    }
    const sent=await notifyBrowser({category:"messages",title:"CUNNACT test notification",body:"Browser notifications are working ✓",force:true});
    if(sent)showToast("Test notification sent","success");
    else showToast("Notification could not be shown. Check the browser permission for CUNNACT.","error");
  }catch(err){showToast(err?.message||"Could not send test notification.","error");}
});
document.querySelectorAll('input[name="themeMode"]').forEach(r=>r.addEventListener("change",async(e)=>{applyLocalTheme(e.target.value);try{await setUserSetting(currentUser.uid,{theme:pendingTheme});}catch(err){console.warn(err);}playClick();}));
$("shareProfileBtn")?.addEventListener("click",async()=>{const username=normalizeUsername($("profileUsername").value);if(!username){showToast("Set a CUNNACT ID before sharing your profile.","info");$("profileUsername").focus();return;}const url=`${location.origin}/u/${encodeURIComponent(username)}`,text=`Connect with me on CUNNACT:\n@${username}`;try{if(navigator.share)await navigator.share({title:"CUNNACT profile",text,url});else{await navigator.clipboard.writeText(url);showToast("Profile link copied ✓","success");}}catch(e){if(e.name!=="AbortError")showToast("Could not share profile link","error");}});
$("backToChat")?.addEventListener("click",()=>location.href="index.html");$("cancelProfileBtn")?.addEventListener("click",()=>location.href="index.html");


async function refreshSecurityUI(){
  const state = $("mfaState");
  const btn = $("mfaPrimaryBtn");

  if(state && auth.currentUser){
    const enrolled = multiFactor(auth.currentUser).enrolledFactors || [];
    state.textContent = enrolled.length
      ? `${enrolled.length} second factor${enrolled.length > 1 ? "s" : ""} enabled`
      : "Not enabled";
    if(btn) btn.textContent = enrolled.length ? "Manage 2-step verification" : "Enable 2-step verification";
    btn?.classList.toggle("btn-soft", !!enrolled.length);
  }

  const devicesBox = $("deviceSessionsList");
  const eventsBox = $("securityEventsList");
  if(!devicesBox || !currentUser) return;

  devicesBox.innerHTML = '<div class="empty-state">Loading devices…</div>';
  try{
    const devices = await listDevices(currentUser);
    if(!devices.length){
      devicesBox.innerHTML = '<div class="empty-state">No active sessions found.</div>';
    }else{
      devicesBox.innerHTML = devices.map((d) => {
        const label = String(d.label || "CUNNACT device");
        const stateText = `${d.current ? "This device · " : ""}${d.active === false ? "Signed out" : "Active"}`;
        const sessionId = String(d.id || "");
        const currentSessionId = String(getDeviceSessionId() || "");
        const action = sessionId !== currentSessionId && d.active !== false
          ? `<button type="button" class="btn btn-soft btn-sm" data-revoke-device="${sessionId}">Sign out</button>`
          : '<span class="device-current">✓</span>';
        return `<div class="device-row"><div><strong>${label}</strong><small>${stateText}</small></div>${action}</div>`;
      }).join("");

      devicesBox.querySelectorAll("[data-revoke-device]").forEach((button) => {
        button.addEventListener("click", async () => {
          try{
            await revokeDevice(currentUser, button.dataset.revokeDevice);
            await refreshSecurityUI();
            showToast("Device signed out", "success");
          }catch(err){
            console.error("Device revoke failed", err);
            showToast("Could not sign out that device", "error");
          }
        });
      });
    }
  }catch(err){
    console.error("Device list failed", err);
    devicesBox.innerHTML = '<div class="empty-state">Could not load sessions.</div>';
  }

  if(eventsBox){
    eventsBox.innerHTML = '<div class="empty-state">Loading activity…</div>';
    try{
      const snap = await getDocs(query(
        collection(db, "securityEvents"),
        where("userId", "==", currentUser.uid),
        orderBy("createdAt", "desc"),
        limit(20)
      ));
      eventsBox.innerHTML = snap.empty
        ? '<div class="empty-state">No security activity yet.</div>'
        : snap.docs.map((d) => {
            const x = d.data();
            const when = x.createdAt?.toDate?.();
            return `<div class="device-row"><div><strong>${String(x.type || "Security event").replace(/_/g, " ")}</strong><small>${when ? when.toLocaleString() : "Recently"} · ${String(x.details || "").slice(0, 120)}</small></div></div>`;
          }).join("");
    }catch(err){
      console.error("Security events load failed", err);
      eventsBox.innerHTML = '<div class="empty-state">Could not load security activity.</div>';
    }
  }
}

async function enrollMfa(){
  const user=auth.currentUser;if(!user)return;
  try{
    const provider=(user.providerData||[]).find(p=>p.providerId==="password");
    if(provider){const password=window.prompt("Enter your current CUNNACT password to continue");if(!password)return;await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password));}
    else if((user.providerData||[]).some(p=>p.providerId==="google.com")){await reauthenticateWithPopup(user,new GoogleAuthProvider());}
    const phone=window.prompt("Enter your phone number with country code, e.g. +919876543210");if(!phone)return;
    if(!recaptchaVerifier)recaptchaVerifier=new RecaptchaVerifier(auth,"mfaRecaptcha",{size:"normal"});
    const session=await multiFactor(user).getSession();
    const verificationId=await new PhoneAuthProvider(auth).verifyPhoneNumber({phoneNumber:phone,session},recaptchaVerifier);mfaVerificationId=verificationId;mfaUser=user;
    const code=window.prompt("Enter the SMS verification code");if(!code)return;
    const cred=PhoneAuthProvider.credential(mfaVerificationId,code);const assertion=PhoneMultiFactorGenerator.assertion(cred);await multiFactor(user).enroll(assertion,"CUNNACT phone");
    await setDoc(doc(db,"userSettings",user.uid),{mfaEnabled:true,mfaUpdatedAt:serverTimestamp()},{merge:true});await writeSecurityEvent(user,{type:"mfa_enabled",details:"SMS two-step verification enabled"});showToast("2-step verification enabled","success");await refreshSecurityUI();
  }catch(e){console.error("MFA enrollment failed",e);showToast(e?.code==="auth/requires-recent-login"?"Please sign in again, then enable 2-step verification.":e?.code==="auth/operation-not-allowed"?"Enable SMS Multi-factor Authentication in Firebase Authentication first.":e?.message||"Could not enable 2-step verification.","error");try{recaptchaVerifier?.clear();}catch{}recaptchaVerifier=null;}
}
async function manageMfa(){
  const user=auth.currentUser;if(!user)return;const factors=multiFactor(user).enrolledFactors||[];
  if(!factors.length){await enrollMfa();return;}
  const action=window.prompt(`2-step verification is enabled (${factors.length} factor). Type REMOVE to remove all factors.`);if(action!=="REMOVE")return;
  for(const factor of factors){try{await multiFactor(user).unenroll(factor.uid);}catch(e){showToast(e?.code==="auth/requires-recent-login"?"Please sign in again, then try removing 2-step verification.":"Could not remove factor.","error");return;}}
  await setDoc(doc(db,"userSettings",user.uid),{mfaEnabled:false,mfaUpdatedAt:serverTimestamp()},{merge:true});await writeSecurityEvent(user,{type:"mfa_disabled",details:"Two-step verification disabled"});showToast("2-step verification disabled","info");refreshSecurityUI();
}

$("mfaPrimaryBtn")?.addEventListener("click",manageMfa);
$("readReceiptsToggle")?.addEventListener("change",async e=>{if(!currentUser)return;try{await setUserSetting(currentUser.uid,{showReadReceipts:e.target.checked});showToast(e.target.checked?"Read receipts enabled":"Read receipts disabled","success");}catch(err){console.error(err);e.target.checked=!e.target.checked;showToast("Could not update read receipts","error");}});
$("typingIndicatorsToggle")?.addEventListener("change",async e=>{if(!currentUser)return;try{await setUserSetting(currentUser.uid,{showTypingIndicators:e.target.checked});showToast(e.target.checked?"Typing indicators enabled":"Typing indicators disabled","success");}catch(err){console.error(err);e.target.checked=!e.target.checked;showToast("Could not update typing indicators","error");}});
$("lastSeenToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const value=!e.target.checked;try{await updateDoc(doc(db,"users",currentUser.uid),{hideLastSeen:value,updatedAt:serverTimestamp()}); currentUserData={...currentUserData,hideLastSeen:value}; window.CUNNACTApp?.syncOwnProfile?.({hideLastSeen:value}); showToast(value?"Last seen hidden":"Last seen visible","success");}catch(err){console.error(err);e.target.checked=!e.target.checked;showToast("Could not update last seen","error");}});
$("profileVisibility")?.addEventListener("change",async e=>{if(!currentUser)return;const value=e.target.value;try{await updateDoc(doc(db,"users",currentUser.uid),{profileVisibility:value});await updateDoc(doc(db,"publicProfiles",currentUser.uid),{profileVisibility:value}).catch(()=>{});showToast(value==="public"?"Profile is public":"Profile is private","success");}catch(err){console.error(err);showToast("Could not update profile visibility","error");}});
$("discoverableToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const value=!!e.target.checked;try{await updateDoc(doc(db,"users",currentUser.uid),{discoverable:value});await updateDoc(doc(db,"publicProfiles",currentUser.uid),{discoverable:value}).catch(()=>{});showToast(value?"Profile can appear in discovery":"Profile hidden from discovery","success");}catch(err){console.error(err);e.target.checked=!e.target.checked;showToast("Could not update discovery setting","error");}});

function privacySummary(value){
  const map={everyone:"Everyone",contacts:"My contacts",nobody:"Nobody"};
  return map[value]||"Everyone";
}
function getPrivacySettings(){
  return {
    lastSeen: profileSettings.lastSeenAudience || (currentUserData?.hideLastSeen===true ? "nobody" : "everyone"),
    profilePicture: profileSettings.profilePictureAudience || "everyone",
    about: profileSettings.aboutAudience || "everyone",
    groups: profileSettings.groupPrivacy || "everyone",
    defaultTimer: profileSettings.retentionMode || getRetentionMode(),
    tracePrivacy: profileSettings.traceAudienceDefault || "public"
  };
}
async function savePrivacyField(field,value,label,summaryId){
  if(!currentUser)return;
  try{
    await setUserSetting(currentUser.uid,{[field]:value});
    profileSettings={...profileSettings,[field]:value};
    const node=$(summaryId);if(node)node.textContent=label;
    showToast(`${label} saved`,'success');
  }catch(err){console.error(err);showToast('Could not save privacy setting','error');}
}
function openPrivacyChoice(kind){
  const modal=$("privacyChoiceModal"), title=$("privacyChoiceTitle"), body=$("privacyChoiceBody");
  if(!modal||!title||!body)return;
  const s=getPrivacySettings();
  const configs={
    'last-seen':{title:'Last seen and online',field:'lastSeenAudience',summaryId:'lastSeenSummary',value:s.lastSeen,options:[['everyone','Everyone','Anyone you allow to see your profile can see this.'],['contacts','My contacts','Only people you are connected with.'],['nobody','Nobody','Hide your last seen. Your existing last-seen toggle remains in effect.']]},
    'profile-picture':{title:'Profile picture',field:'profilePictureAudience',summaryId:'profilePictureSummary',value:s.profilePicture,options:[['everyone','Everyone','Show your profile picture to everyone who can access your profile.'],['contacts','My contacts','Show it to people you are connected with.'],['nobody','Nobody','Hide your profile picture from others.']]},
    'about':{title:'About',field:'aboutAudience',summaryId:'aboutSummary',value:s.about,options:[['everyone','Everyone','Show your About text to everyone who can access your profile.'],['contacts','My contacts','Show it to connected contacts.'],['nobody','Nobody','Hide your About text from others.']]},
    'trace':{title:'Trace privacy',field:'traceAudienceDefault',summaryId:'statusSummary',value:s.tracePrivacy,options:[['public','Everyone','New traces use this audience by default. You can change the audience for each trace.'],['closeFriends','Close friends','New traces default to your selected close-friend audience.'],['custom','Selected people','New traces default to a selected audience. You will choose people before publishing.']]},
    'groups':{title:'Groups',field:'groupPrivacy',summaryId:'groupPrivacySummary',value:s.groups,options:[['everyone','Everyone','Anyone can add you to a group when the app supports the request.'],['contacts','My contacts','Only connected contacts can add you.'],['nobody','Nobody','Require an invite/request flow before joining.']]},
    'default-timer':{title:'Default message timer',field:'retentionMode',summaryId:'defaultTimerSummary',value:s.defaultTimer,options:[['off','Off','Keep messages until you delete them.'],['24hours','24 hours','Messages expire after 24 hours unless saved.'],['seen','After seen','Messages expire after they are read.']]}
  };
  const cfg=configs[kind];
  if(!cfg)return;
  title.textContent=cfg.title;
  body.innerHTML=cfg.options.map(([v,l,d])=>`<label class="privacy-choice-option"><span class="copy"><strong>${l}</strong><small>${d}</small></span><input type="radio" name="privacyChoice" value="${v}" ${cfg.value===v?'checked':''}></label>`).join('');
  body.querySelectorAll('input[name="privacyChoice"]').forEach(input=>input.addEventListener('change',async()=>{
    const value=input.value;
    if(cfg.field==='retentionMode'){
      if(value==='off'){
        try{await setUserSetting(currentUser.uid,{retentionMode:'off'});profileSettings.retentionMode='off';$(cfg.summaryId).textContent='Off';showToast('Default message timer set to Off','success');}
        catch(err){console.error(err);showToast('Could not save message timer','error');}
      }else{try{await setRetentionMode(value,currentUser.uid);profileSettings.retentionMode=value;$(cfg.summaryId).textContent=value==='seen'?'After seen':'24 hours';showToast('Default message timer updated','success');}catch(err){console.error(err);showToast('Could not save message timer','error');}}
    }else{
      const summary=privacySummary(value);await savePrivacyField(cfg.field,value,summary,cfg.summaryId);
      if(cfg.field==='lastSeenAudience'){const hide=value==='nobody';try{await updateDoc(doc(db,'users',currentUser.uid),{hideLastSeen:hide}); currentUserData={...currentUserData,hideLastSeen:hide}; window.CUNNACTApp?.syncOwnProfile?.({hideLastSeen:hide}); if($("lastSeenToggle"))$("lastSeenToggle").checked=!hide;}catch(err){console.warn('last seen sync failed',err);}}
    }
    modal.hidden=true;
  }));
  modal.hidden=false;
}
async function openBlockedContacts(){
  const modal=$("privacyChoiceModal"),title=$("privacyChoiceTitle"),body=$("privacyChoiceBody");if(!modal||!title||!body||!currentUser)return;
  title.textContent='Blocked contacts';body.innerHTML='<div class="privacy-blocked-empty">Loading blocked contacts…</div>';modal.hidden=false;
  try{const snap=await getDocs(collection(db,'users',currentUser.uid,'blockedUsers'));
    const rows=snap.docs.map(d=>{const x=d.data()||{};return `<div class="privacy-blocked-item"><div><strong>${escapeHtml(x.name||x.displayName||x.email||d.id)}</strong><small>${escapeHtml(x.username?`@${x.username}`:d.id)}</small></div><button type="button" class="btn btn-soft btn-sm" data-unblock="${escapeHtml(d.id)}">Unblock</button></div>`}).join('');
    body.innerHTML=rows||'<div class="privacy-blocked-empty">You have no blocked contacts.</div>';
    body.querySelectorAll('[data-unblock]').forEach(btn=>btn.addEventListener('click',async()=>{try{await deleteDoc(doc(db,'users',currentUser.uid,'blockedUsers',btn.dataset.unblock));btn.closest('.privacy-blocked-item')?.remove();showToast('Contact unblocked','success');await updatePrivacySummaries();}catch(err){console.error(err);showToast('Could not unblock contact','error');}}));
  }catch(err){console.error(err);body.innerHTML='<div class="privacy-blocked-empty">Could not load blocked contacts.</div>';}
}
function openAppLock(){document.querySelector('[data-target="#securitySection"]')?.click();$("appLockToggle")?.focus();}
async function updatePrivacySummaries(){
  const s=getPrivacySettings();
  $("lastSeenSummary").textContent=privacySummary(s.lastSeen);
  $("profilePictureSummary").textContent=privacySummary(s.profilePicture);
  $("aboutSummary").textContent=privacySummary(s.about);
  $("groupPrivacySummary").textContent=privacySummary(s.groups);
  $("defaultTimerSummary").textContent=s.defaultTimer==='seen'?'After seen':s.defaultTimer==='24hours'?'24 hours':'Off';
  $("statusSummary").textContent=s.tracePrivacy==='public'?'Everyone':s.tracePrivacy==='closeFriends'?'Close friends':s.tracePrivacy==='custom'?'Selected people':'Everyone';
  if($("blockedContactsSummary")){try{const snap=await getDocs(collection(db,'users',currentUser.uid,'blockedUsers'));$("blockedContactsSummary").textContent=String(snap.size);}catch{}}
  if($("appLockSummary"))$("appLockSummary").textContent=profileSettings.appLockEnabled?'On':'Off';
}
$("privacyChoiceClose")?.addEventListener('click',()=>$("privacyChoiceModal").hidden=true);
$("privacyChoiceModal")?.addEventListener('click',e=>{if(e.target.id==='privacyChoiceModal')e.currentTarget.hidden=true;});
document.querySelectorAll('[data-privacy-dialog]').forEach(btn=>btn.addEventListener('click',()=>{const kind=btn.dataset.privacyDialog;if(kind==='blocked')openBlockedContacts();else if(kind==='app-lock')openAppLock();else openPrivacyChoice(kind);}));
$("appLockToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const enable=!!e.target.checked;if(enable){const pin=window.prompt("Create a 4–8 digit app lock PIN");if(!/^\d{4,8}$/.test(pin||"")){e.target.checked=false;showToast("PIN must be 4–8 digits.","error");return;}const {salt,hash}=await createPinHash(pin);await setDoc(doc(db,"userSettings",currentUser.uid),{appLockEnabled:true,appLockSalt:salt,appLockHash:hash},{merge:true});profileSettings={...profileSettings,appLockEnabled:true,appLockSalt:salt,appLockHash:hash};await writeSecurityEvent(currentUser,{type:"app_lock_enabled",details:"App lock enabled"});showToast("App lock enabled","success");}else{await setDoc(doc(db,"userSettings",currentUser.uid),{appLockEnabled:false,appLockSalt:null,appLockHash:null},{merge:true});profileSettings={...profileSettings,appLockEnabled:false};await writeSecurityEvent(currentUser,{type:"app_lock_disabled",details:"App lock disabled"});showToast("App lock disabled","info");}});
$("refreshSessionsBtn")?.addEventListener("click",refreshSecurityUI);
$("signOutOtherDevicesBtn")?.addEventListener("click",async()=>{if(!currentUser)return;try{const count=await revokeOtherDevices(currentUser);await writeSecurityEvent(currentUser,{type:"sessions_revoked",details:`Signed out ${Math.max(0,count-1)} other device session(s)`});showToast("Other devices signed out","success");refreshSecurityUI();}catch(e){console.error(e);showToast("Could not sign out other devices.","error");}});

$("deleteAccountBtn")?.addEventListener("click",async()=>{if(!currentUser)return;const confirmation=window.prompt("This permanently signs you out everywhere and removes your CUNNACT identity. Type DELETE to continue.");if(confirmation!=="DELETE")return;const btn=$("deleteAccountBtn");try{btn.disabled=true;btn.textContent="Deleting…";const callable=httpsCallable(functions,"deleteMyAccount");await callable({confirmation:"DELETE"});showToast("Your CUNNACT account has been deleted.","success");setTimeout(()=>location.replace("login.html?deleted=1"),700);}catch(e){console.error("Account deletion failed",e);showToast(e?.message||"Could not delete your account.","error");btn.disabled=false;btn.textContent="Delete my CUNNACT account";}});

$("profileForm")?.addEventListener("submit",async(e)=>{
  e.preventDefault();if(!currentUser)return;setStatus("Saving…");const name=$("profileName").value.trim(),bio=$("profileBio").value.trim(),username=normalizeUsername($("profileUsername").value);
  if(name.length<1){setStatus("Display name is required.","error");return;}
  if(!PATTERN.test(username)||RESERVED.has(username)){setStatus("Choose a valid CUNNACT ID.","error");$("profileUsername").focus();return;}
  const old=original.username;
  try{
    if(username!==old){const free=await usernameAvailable(username);if(!free){setStatus("That CUNNACT ID is not available.","error");return;}await claimUsername(username,old,name,bio,currentPhotoURL||"");}
    else {await updateDoc(doc(db,"users",currentUser.uid),{name,bio,photoURL:currentPhotoURL||""});await savePublicProfile(name,bio,username);if(!old)await runTransaction(db,async(tx)=>{const ref=doc(db,"usernames",username),snap=await tx.get(ref);if(snap.exists()&&snap.data()?.uid!==currentUser.uid)throw new Error("USERNAME_TAKEN");tx.set(ref,{uid:currentUser.uid,createdAt:serverTimestamp()},{merge:true});});}
    await updateProfile(currentUser,{displayName:name,photoURL:currentPhotoURL||null});
    await setUserSetting(currentUser.uid,{retentionMode:getRetentionMode(),soundEnabled:isSoundEnabled(),theme:pendingTheme});
    original={name,username,bio,photoURL:currentPhotoURL,retention:getRetentionMode(),sound:isSoundEnabled(),theme:pendingTheme};
    window.CUNNACTApp?.syncOwnProfile?.({name,bio,username,usernameLower:username,photoURL:currentPhotoURL||""});
    updatePreview();setStatus("Changes saved ✓");showToast("Profile updated","success");
  }catch(err){console.error("Profile save failed",err);setStatus(err?.message==="USERNAME_TAKEN"?"That CUNNACT ID is already taken.":"Could not save your profile. Please try again.","error");}
});

// Settings 2.0 interaction layer: account actions, media tests and help links.
function downloadTextFile(filename, text){
  const blob=new Blob([text],{type:'application/json'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

// Account actions should perform a real action instead of showing placeholder text.
document.querySelector('[data-account-action="security-notifications"]')?.addEventListener('click',()=>{
  document.querySelector('[data-target="#securitySection"]')?.click();
});
document.querySelector('[data-account-action="request-info"]')?.addEventListener('click',async()=>{
  if(!currentUser)return;
  try{
    const snap=await getDoc(doc(db,"users",currentUser.uid));
    const data=snap.exists()?snap.data():{};
    const safe={name:data.name||currentUser.displayName||"",email:currentUser.email||"",username:data.username||"",bio:data.bio||"",createdAt:data.createdAt||null};
    downloadTextFile(`cunnact-account-info-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(safe,null,2));
    showToast("Account information downloaded","success");
  }catch(err){console.error(err);showToast("Could not prepare account information","error");}
});
document.querySelector('[data-account-action="delete-account-info"]')?.addEventListener('click',()=>{
  showToast("To delete your account, open Account and use the Delete my CUNNACT account control.","info");
});

let settingsMediaStream=null;
async function stopSettingsCamera(){
  settingsMediaStream?.getTracks().forEach(t=>t.stop()); settingsMediaStream=null;
  const preview=$("cameraPreview"); if(preview){preview.srcObject=null;preview.hidden=true;}
}
$("testCameraBtn")?.addEventListener("click",async()=>{
  const preview=$("cameraPreview"), status=$("cameraDeviceStatus");
  try{
    await stopSettingsCamera();
    settingsMediaStream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    preview.srcObject=settingsMediaStream;preview.hidden=false;status.textContent="Camera permission granted and preview is live.";showToast("Camera is working","success");
    setTimeout(stopSettingsCamera,8000);
  }catch(err){status.textContent="Camera permission was not granted or no camera is available.";showToast("Could not access the camera","error");}
});
$("testMicrophoneBtn")?.addEventListener("click",async()=>{
  const status=$("microphoneDeviceStatus"); let stream=null;
  try{
    stream=await navigator.mediaDevices.getUserMedia({audio:true});
    status.textContent="Microphone permission granted and input is available.";showToast("Microphone is working","success");
  }catch(err){status.textContent="Microphone permission was not granted or no microphone is available.";showToast("Could not access the microphone","error");}
  finally{stream?.getTracks().forEach(t=>t.stop());}
});
$("testSpeakerBtn")?.addEventListener("click",async()=>{
  try{
    const C=window.AudioContext||window.webkitAudioContext;if(!C)throw new Error("Audio unavailable");
    const ctx=new C(),osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=660;gain.gain.value=.045;osc.connect(gain).connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.22);showToast("Speaker test played","success");
  }catch(err){showToast("Could not play speaker test","error");}
});

$("helpContactBtn")?.addEventListener("click",()=>{location.href="mailto:support@cunnact.com?subject=CUNNACT%20Support%20Request";});
$("helpFeedbackBtn")?.addEventListener("click",()=>{location.href="mailto:feedback@cunnact.com?subject=CUNNACT%20Feedback";});
$("helpPrivacyBtn")?.addEventListener("click",()=>{window.CUNNACTSettings?.open?.("#privacySection");});


// In-place Settings navigation (WhatsApp Web-style: settings list on the left,
// selected details on the right, all inside index.html).
(function initInPlaceSettingsNavigation(){
  const root=document.getElementById('ownProfileView');
  if(!root)return;
  const title=document.getElementById('settingsDetailTitle');
  const subtitle=document.getElementById('settingsDetailSubtitle');
  const items=[...document.querySelectorAll('#ownProfileView .settings-nav-item')];
  const sections=[...document.querySelectorAll('#ownProfileView .settings-detail-scroll .settings-card-v6')];
  const profilePreview=document.getElementById('settingsProfilePreview');
  const meta={
    '#generalSection':['General','Startup and close'],
    '#profileSection':['Profile','Name, profile picture and username'],
    '#dataSection':['Account','Security notifications, account info'],
    '#privacySection':['Privacy','Who can see your personal information and activity'],
    '#preferencesSection':['Chats','Theme, wallpaper and chat settings'],
    '#videoVoiceSection':['Video & voice','Camera, microphone & speakers'],
    '#notificationsSection':['Notifications','Messages, groups, sounds'],
    '#securitySection':['Security','App lock, 2-step verification, devices'],
    '#keyboardShortcutsSection':['Keyboard shortcuts','Quick actions'],
    '#helpSection':['Help and feedback','Help centre, contact us, privacy policy'],
  };
  function go(target,button){
    const node=document.querySelector(target);
    if(!node)return;
    sections.forEach(section=>{section.hidden=section!==node;});
    if(window.innerWidth<=820)root.classList.add('mobile-detail-open');
    // Profile action bar only applies to the personal information editor.
    const actions=document.querySelector('.settings-profile-actions');
    if(actions)actions.hidden=target!=='#profileSection';
    items.forEach(x=>x.classList.toggle('active',x===button));
    profilePreview?.classList.toggle('active',target==='#profileSection');
    const m=meta[target]||['Settings','CUNNACT preferences'];
    if(title)title.textContent=m[0];
    if(subtitle)subtitle.textContent=m[1];
    document.getElementById('settingsDetail')?.scrollTo({top:0,behavior:'auto'});
    if(root.dataset.settingsReady==='true'){
      const hash=target==='#generalSection'?'#settings':target==='#profileSection'?'#profile':target.replace('Section','');
      if(location.hash!==hash)history.replaceState(null,'',`${location.pathname}${location.search}${hash}`);
    }
  }
  window.CUNNACTSettings={open:(target='#generalSection')=>{
    root.hidden=false;
    document.getElementById('app')?.classList.add('profile-open');
    const btn=items.find(x=>x.dataset.target===target) || items[0];
    go(target,btn);
  },go,close:()=>document.getElementById('backToChat')?.click()};
  items.forEach(btn=>btn.addEventListener('click',()=>go(btn.dataset.target,btn)));
  const openProfilePreview=()=>go('#profileSection',null);
  profilePreview?.addEventListener('click',openProfilePreview);
  document.getElementById('settingsAvatarButton')?.addEventListener('click',e=>e.stopPropagation());
  profilePreview?.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openProfilePreview();}});
  document.querySelectorAll('#ownProfileView .settings-section-back').forEach(btn=>btn.addEventListener('click',()=>go(btn.dataset.target||'#generalSection',items.find(x=>x.dataset.target===(btn.dataset.target||'#generalSection')))));
  document.getElementById('settingsSearch')?.addEventListener('input',e=>{
    const q=String(e.target.value||'').trim().toLowerCase();
    items.forEach(btn=>btn.hidden=!!q&&!btn.textContent.toLowerCase().includes(q));
  });
  document.getElementById('settingsDetailBack')?.addEventListener('click',()=>{
    if(window.innerWidth<=820){root.classList.remove('mobile-detail-open');sections.forEach(section=>{section.hidden=true;});const general=document.getElementById('generalSection');if(general)general.hidden=false;items.forEach((x,i)=>x.classList.toggle('active',i===0));}
  });
  document.getElementById('backToChat')?.addEventListener('click',()=>{
    root.classList.remove('mobile-detail-open');
    root.hidden=true;
    document.getElementById('app')?.classList.remove('profile-open');
    document.getElementById('sidebarDefaultView')?.removeAttribute('hidden');
    document.getElementById('navChatsBtn')?.classList.add('active');
    if(location.hash)history.replaceState(null,'',location.pathname+location.search);
  });
  root.dataset.settingsReady='true';
  // General controls persisted locally, just like the former page.
  const startAtLogin=document.getElementById('startAtLoginToggle');
  const minimizeToTray=document.getElementById('minimizeToTrayToggle');
  const language=document.getElementById('generalLanguageSelect');
  const fontSize=document.getElementById('generalFontSizeSelect');
  if(startAtLogin)startAtLogin.checked=localStorage.getItem('cunnact_start_at_login')==='true';
  if(minimizeToTray)minimizeToTray.checked=localStorage.getItem('cunnact_minimize_to_tray')==='true';
  if(language)language.value=localStorage.getItem('cunnact_language')||'en-GB';
  if(fontSize){const saved=localStorage.getItem('cunnact_font_scale')||'100';fontSize.value=saved;document.documentElement.style.setProperty('--cunnact-font-scale',(Number(saved)/100).toFixed(2));}
  startAtLogin?.addEventListener('change',e=>localStorage.setItem('cunnact_start_at_login',String(e.target.checked)));
  minimizeToTray?.addEventListener('change',e=>localStorage.setItem('cunnact_minimize_to_tray',String(e.target.checked)));
  language?.addEventListener('change',e=>localStorage.setItem('cunnact_language',e.target.value));
  fontSize?.addEventListener('change',e=>{localStorage.setItem('cunnact_font_scale',e.target.value);document.documentElement.style.setProperty('--cunnact-font-scale',(Number(e.target.value)/100).toFixed(2));});
  document.addEventListener('keydown',e=>{
    const panelOpen=!root.hidden;
    if(!panelOpen)return;
    if(e.ctrlKey&&(e.key==='+'||e.key==='='||e.key==='-')){e.preventDefault();const vals=[90,100,110,125],current=Number(fontSize?.value||100),idx=Math.max(0,vals.indexOf(current)),next=vals[Math.min(vals.length-1,Math.max(0,idx+(e.key==='-'?-1:1)))];if(fontSize){fontSize.value=String(next);fontSize.dispatchEvent(new Event('change'));}}
    if(e.key==='Escape'&&!e.target.closest('input,textarea,select'))document.getElementById('backToChat')?.click();
  });
  const syncPreview=()=>{
    const src=document.getElementById('profileAvatar'), dst=document.getElementById('settingsSidebarAvatar');
    const srcImg=src?.querySelector('img'),srcFallback=src?.querySelector('.avatar-fallback');
    const dstImg=dst?.querySelector('img'),dstFallback=dst?.querySelector('.avatar-fallback');
    if(srcImg&&dstImg){dstImg.src=srcImg.src;dstImg.hidden=srcImg.hidden;}
    if(srcFallback&&dstFallback){dstFallback.textContent=srcFallback.textContent;dstFallback.hidden=srcFallback.hidden;}
    const name=document.getElementById('heroDisplayName')?.textContent||document.getElementById('profileName')?.value||'Your name';
    const previewName=document.getElementById('settingsPreviewName'),sidebarName=document.getElementById('settingsSidebarName');
    if(previewName)previewName.textContent=name;if(sidebarName&&sidebarName.textContent!=='Settings')sidebarName.textContent='Settings';
  };
  const src=document.getElementById('profileAvatar');
  if(src)new MutationObserver(syncPreview).observe(src,{subtree:true,attributes:true,childList:true});
  const pName=document.getElementById('profileName'); pName?.addEventListener('input',syncPreview);
  window.CUNNACTSettings.syncPreview=syncPreview;
  // Logout item is intentionally an action, not a detail page.
  const logoutNav=document.getElementById('settingsLogoutNav');
  if(logoutNav)logoutNav.addEventListener('click',()=>window.CUNNACTSettingsLogout?.());
  // Open from an index hash after auth bootstrap.
  const hash=location.hash;
  const route={'#settings':'#generalSection','#profile':'#profileSection','#privacy':'#privacySection','#generalSection':'#generalSection','#privacySection':'#privacySection','#securitySection':'#securitySection','#dataSection':'#dataSection','#preferencesSection':'#preferencesSection','#videoVoiceSection':'#videoVoiceSection','#notificationsSection':'#notificationsSection','#keyboardShortcutsSection':'#keyboardShortcutsSection','#helpSection':'#helpSection'};
  if(route[hash] && window.CUNNACTSettings){setTimeout(()=>window.CUNNACTSettings.open(route[hash]),0);}
})();
