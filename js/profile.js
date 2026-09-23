import {
  auth, db, onAuthStateChanged, updateProfile, doc, getDoc, setDoc,
  updateDoc, serverTimestamp, runTransaction
} from "./firebase.js";
import { uploadImageToCloudinary, UploadError } from "./cloudinary.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";
import { $, debounce } from "./ui.js";
import { isSoundEnabled, setSoundEnabled, playClick, playSuccess } from "./sound.js";
import { getRetentionMode, loadRetentionMode, setRetentionMode, setUserSetting } from "./retention.js";

let currentUser = null;
let currentPhotoURL = "";
let original = {};
let usernameToken = 0;
let uploadController = null;
let pendingTheme = localStorage.getItem("cunnact_theme") || "light";
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
async function savePublicProfile(name,bio,username){await setDoc(doc(db,"publicProfiles",currentUser.uid),{uid:currentUser.uid,username,usernameLower:username,displayName:name,photoURL:currentPhotoURL||"",bio,updatedAt:serverTimestamp()},{merge:true});}
function resolveThemeLocal(pref){if(pref==="dark")return "dark";if(pref==="system")return (window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light";return "light";}
function applyLocalTheme(theme){const t=(theme==="dark"||theme==="system")?theme:"light";pendingTheme=t;document.documentElement.dataset.theme=resolveThemeLocal(t);localStorage.setItem("cunnact_theme",t);document.querySelectorAll('input[name="themeMode"]').forEach(r=>{r.checked=(r.value===t);});}

onAuthStateChanged(auth,async(user)=>{
  if(!user){location.replace("login.html");return;}
  currentUser=user;
  try{
    const userSnap=await getDoc(doc(db,"users",user.uid)), data=userSnap.exists()?userSnap.data():{};
    const settingsSnap=await getDoc(doc(db,"userSettings",user.uid)), settings=settingsSnap.exists()?settingsSnap.data():{};
    const name=data.name||user.displayName||user.email||"User", username=normalizeUsername(data.username||""), bio=data.bio||"";
    currentPhotoURL=data.photoURL||user.photoURL||"";pendingTheme=settings.theme||localStorage.getItem("cunnact_theme")||"light";applyLocalTheme(pendingTheme);
    original={name,username,bio,photoURL:currentPhotoURL,retention:settings.retentionMode||"24hours",sound:settings.soundEnabled!==false,theme:pendingTheme};
    $("profileName").value=name;$("profileEmail").value=user.email||data.email||"";$("profileUsername").value=username;$("profileBio").value=bio;if(!username)$("profileUsername").placeholder=suggestedUsername(name,user.email);
    updateBioCount();updatePreview();paintAvatar($("profileAvatar"),{photoURL:currentPhotoURL,name,email:user.email});
    const retention=await loadRetentionMode(user.uid);const retentionRadio=document.querySelector(`input[name="retention"][value="${retention}"]`); if(retentionRadio) retentionRadio.checked=true;
    $("soundToggle").checked=settings.soundEnabled!==false;
    if($("lastSeenToggle"))$("lastSeenToggle").checked=!data.hideLastSeen;
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
