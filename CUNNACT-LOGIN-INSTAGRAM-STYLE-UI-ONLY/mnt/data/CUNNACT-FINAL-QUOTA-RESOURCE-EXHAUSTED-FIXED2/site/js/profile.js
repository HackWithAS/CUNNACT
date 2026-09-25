import {
  auth, db, functions, httpsCallable, onAuthStateChanged, updateProfile, doc, getDoc, getDocs, setDoc,
  updateDoc, serverTimestamp, runTransaction, multiFactor, RecaptchaVerifier, collection, query, where, orderBy, limit,
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
import { enablePushNotifications, disablePushNotifications, notificationsAreEnabled } from "./notifications.js";
import { bindAccountTools } from "./account.js";

let currentUser = null;
let currentPhotoURL = "";
let original = {};
let usernameToken = 0;
let uploadController = null;
let pendingTheme = localStorage.getItem("cunnact_theme") || "light";
let profileSettings = {};
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
function updateBioCount(){const b=$("profileBio"),c=$("bioCount");if(b&&c)c.textContent=String(b.value.length);}
function updatePreview(){const name=$("profileName")?.value.trim()||"Your name", u=normalizeUsername($("profileUsername")?.value)||"username";$("heroDisplayName").textContent=name;$("heroUsername").textContent=`@${u}`;$("publicProfileState").textContent=`@${u}`;}
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
    const name=data.name||user.displayName||user.email||"User", username=normalizeUsername(data.username||""), bio=data.bio||"";
    currentPhotoURL=data.photoURL||user.photoURL||"";pendingTheme=settings.theme||localStorage.getItem("cunnact_theme")||"light";applyLocalTheme(pendingTheme);
    original={name,username,bio,photoURL:currentPhotoURL,retention:settings.retentionMode||"24hours",sound:settings.soundEnabled!==false,theme:pendingTheme};
    $("profileName").value=name;$("profileEmail").value=user.email||data.email||"";$("profileUsername").value=username;$("profileBio").value=bio;if(!username)$("profileUsername").placeholder=suggestedUsername(name,user.email);
    updateBioCount();updatePreview();paintAvatar($("profileAvatar"),{photoURL:currentPhotoURL,name,email:user.email});
    const retention=await loadRetentionMode(user.uid);const retentionRadio=document.querySelector(`input[name="retention"][value="${retention}"]`); if(retentionRadio) retentionRadio.checked=true;
    $("soundToggle").checked=settings.soundEnabled!==false;
    if($("lastSeenToggle"))$("lastSeenToggle").checked=!data.hideLastSeen;
    if($("readReceiptsToggle"))$("readReceiptsToggle").checked=settings.showReadReceipts!==false;
    if($("typingIndicatorsToggle"))$("typingIndicatorsToggle").checked=settings.showTypingIndicators!==false;
    if($("profileVisibility"))$("profileVisibility").value=data.profileVisibility||"public";
    if($("discoverableToggle"))$("discoverableToggle").checked=data.discoverable!==false;
    if($("appLockToggle"))$("appLockToggle").checked=!!settings.appLockEnabled;
    await refreshSecurityUI();
    bindAccountTools({userRef:()=>currentUser});
    const pushBtn=$("pushNotificationsBtn"); if(pushBtn){pushBtn.textContent=notificationsAreEnabled()?"Enabled":"Enable";pushBtn.classList.toggle("is-enabled",notificationsAreEnabled());}
    setStatus("");
  }catch(e){console.error("Profile load error",e);setStatus("Could not load your profile. Please refresh.","error");}
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
$("soundToggle")?.addEventListener("change",async(e)=>{const enabled=!!e.target.checked;setSoundEnabled(enabled);try{await setUserSetting(currentUser.uid,{soundEnabled:enabled});}catch(err){console.error(err);}if(enabled)playClick();});
document.querySelectorAll('input[name="themeMode"]').forEach(r=>r.addEventListener("change",async(e)=>{applyLocalTheme(e.target.value);try{await setUserSetting(currentUser.uid,{theme:pendingTheme});}catch(err){console.warn(err);}playClick();}));
$("lastSeenToggle")?.addEventListener("change",async(e)=>{const showLastSeen=!!e.target.checked;try{await updateDoc(doc(db,"users",currentUser.uid),{hideLastSeen:!showLastSeen});showToast(showLastSeen?"Others can see your last seen again":"Your last seen is now hidden — you also won't see others'","success");}catch(err){console.error(err);e.target.checked=!showLastSeen;showToast("Could not update last seen setting","error");}playClick();});
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
$("readReceiptsToggle")?.addEventListener("change",e=>{if(currentUser)setUserSetting(currentUser.uid,{showReadReceipts:e.target.checked});});
$("typingIndicatorsToggle")?.addEventListener("change",e=>{if(currentUser)setUserSetting(currentUser.uid,{showTypingIndicators:e.target.checked});});
$("lastSeenToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const value=!e.target.checked;try{await updateDoc(doc(db,"users",currentUser.uid),{hideLastSeen:value,updatedAt:serverTimestamp()});currentUserData={...currentUserData,hideLastSeen:value};showToast(value?"Last seen hidden":"Last seen visible","success");}catch{e.target.checked=!e.target.checked;showToast("Could not update last seen","error");}});
$("profileVisibility")?.addEventListener("change",async e=>{if(!currentUser)return;const value=e.target.value;await updateDoc(doc(db,"users",currentUser.uid),{profileVisibility:value});await updateDoc(doc(db,"publicProfiles",currentUser.uid),{profileVisibility:value}).catch(()=>{});showToast(value==="public"?"Profile is public":"Profile is private","success");});
$("discoverableToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const value=!!e.target.checked;await updateDoc(doc(db,"users",currentUser.uid),{discoverable:value});await updateDoc(doc(db,"publicProfiles",currentUser.uid),{discoverable:value}).catch(()=>{});showToast(value?"Profile can appear in discovery":"Profile hidden from discovery","success");});
$("appLockToggle")?.addEventListener("change",async e=>{if(!currentUser)return;const enable=!!e.target.checked;if(enable){const pin=window.prompt("Create a 4–8 digit app lock PIN");if(!/^\d{4,8}$/.test(pin||"")){e.target.checked=false;showToast("PIN must be 4–8 digits.","error");return;}const {salt,hash}=await createPinHash(pin);await setDoc(doc(db,"userSettings",currentUser.uid),{appLockEnabled:true,appLockSalt:salt,appLockHash:hash},{merge:true});profileSettings={...profileSettings,appLockEnabled:true,appLockSalt:salt,appLockHash:hash};await writeSecurityEvent(currentUser,{type:"app_lock_enabled",details:"App lock enabled"});showToast("App lock enabled","success");}else{await setDoc(doc(db,"userSettings",currentUser.uid),{appLockEnabled:false,appLockSalt:null,appLockHash:null},{merge:true});profileSettings={...profileSettings,appLockEnabled:false};await writeSecurityEvent(currentUser,{type:"app_lock_disabled",details:"App lock disabled"});showToast("App lock disabled","info");}});
$("refreshSessionsBtn")?.addEventListener("click",refreshSecurityUI);
$("signOutOtherDevicesBtn")?.addEventListener("click",async()=>{if(!currentUser)return;try{const count=await revokeOtherDevices(currentUser);await writeSecurityEvent(currentUser,{type:"sessions_revoked",details:`Signed out ${Math.max(0,count-1)} other device session(s)`});showToast("Other devices signed out","success");refreshSecurityUI();}catch(e){console.error(e);showToast("Could not sign out other devices.","error");}});
$("pushNotificationsBtn")?.addEventListener("click",async()=>{if(!currentUser)return;const btn=$("pushNotificationsBtn");try{if(notificationsAreEnabled()){await disablePushNotifications(currentUser);btn.textContent="Enable";btn.classList.remove("is-enabled");showToast("Push notifications disabled","success");}else{btn.disabled=true;const token=await enablePushNotifications(currentUser);if(token){btn.textContent="Enabled";btn.classList.add("is-enabled");showToast("Push notifications enabled","success");}}}catch(e){showToast(e?.message||"Could not enable notifications.","error");}finally{btn.disabled=false;}});
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
    updatePreview();setStatus("Changes saved ✓");showToast("Profile updated","success");
  }catch(err){console.error("Profile save failed",err);setStatus(err?.message==="USERNAME_TAKEN"?"That CUNNACT ID is already taken.":"Could not save your profile. Please try again.","error");}
});
