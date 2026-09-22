import {
  auth, db, onAuthStateChanged, updateProfile, doc, getDoc, setDoc, updateDoc,
  serverTimestamp, runTransaction
} from "./firebase.js";
import { uploadImageToCloudinary, UploadError } from "./cloudinary.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";
import { $ } from "./ui.js";
import { isSoundEnabled, setSoundEnabled, playClick, playSuccess } from "./sound.js";
import { getRetentionMode, loadRetentionMode, setRetentionMode } from "./retention.js";

let currentUser = null;
let currentPhotoURL = "";
let originalProfile = {};
let usernameTimer = null;
let usernameCheckToken = 0;
let uploadController = null;

const RESERVED = new Set(["admin","administrator","support","help","cunnact","official","security","system","root","api","www","user","users","profile","login","register","settings"]);
const usernamePattern = /^[a-z0-9_]{5,24}$/;

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}
function suggestUsername(name, email) {
  const base = normalizeUsername(name).replace(/[^a-z0-9_]/g, "") || normalizeUsername(String(email || "").split("@")[0]).replace(/[^a-z0-9_]/g, "");
  return base.slice(0, 24);
}
function setProfileStatus(text="", type="") {
  const el=$("profileMessage"); if (!el) return;
  el.textContent=text; el.className=`profile-status ${type}`.trim();
}
function updateBioCount(){ const b=$("profileBio"), c=$("bioCount"); if(b&&c)c.textContent=String(b.value.length); }
function updateIdentityPreview(){
  const name=$("profileName")?.value.trim() || "Your name";
  const u=normalizeUsername($("profileUsername")?.value) || "username";
  $("heroDisplayName").textContent=name; $("heroUsername").textContent=`@${u}`;
  $("publicProfileState").textContent=`@${u}`;
}
function openPhotoPicker(){ playClick(); $("photoInput")?.click(); }

async function checkUsernameAvailability(value) {
  const username=normalizeUsername(value);
  const status=$("usernameStatus");
  if(!username){ status.textContent="Choose a unique ID to share your profile."; status.className=""; return false; }
  if(!usernamePattern.test(username)){ status.textContent="Use 5–24 lowercase letters, numbers or underscores."; status.className="error"; return false; }
  if(RESERVED.has(username)){ status.textContent="That CUNNACT ID is reserved."; status.className="error"; return false; }
  const token=++usernameCheckToken;
  status.textContent="Checking availability…"; status.className="";
  try {
    const snap=await getDoc(doc(db,"usernames",username));
    if(token!==usernameCheckToken)return false;
    const available=!snap.exists() || snap.data()?.uid===currentUser?.uid;
    status.textContent=available ? "✓ Available" : "✕ Username already taken";
    status.className=available?"success":"error";
    return available;
  } catch(e){
    console.error("Username check failed:",e);
    if(token===usernameCheckToken){status.textContent="Could not check availability.";status.className="error";}
    return false;
  }
}

async function claimUsername(newUsername, oldUsername) {
  const next=normalizeUsername(newUsername), old=normalizeUsername(oldUsername);
  if(!usernamePattern.test(next) || RESERVED.has(next)) throw new Error("Invalid CUNNACT ID");
  await runTransaction(db, async (tx)=>{
    const nextRef=doc(db,"usernames",next);
    const oldRef=old?doc(db,"usernames",old):null;
    const userRef=doc(db,"users",currentUser.uid);
    const publicRef=doc(db,"publicProfiles",currentUser.uid);
    const nextSnap=await tx.get(nextRef);
    if(nextSnap.exists() && nextSnap.data()?.uid!==currentUser.uid) throw new Error("USERNAME_TAKEN");
    tx.set(nextRef,{uid:currentUser.uid,createdAt:nextSnap.exists()?nextSnap.data()?.createdAt:serverTimestamp()},{merge:true});
    if(old && old!==next && oldRef){
      const oldSnap=await tx.get(oldRef);
      if(oldSnap.exists() && oldSnap.data()?.uid===currentUser.uid) tx.delete(oldRef);
    }
    tx.set(userRef,{username:next,usernameLower:next},{merge:true});
    tx.set(publicRef,{
      uid:currentUser.uid,username:next,usernameLower:next,
      displayName:$("profileName").value.trim(),photoURL:currentPhotoURL||"",
      bio:$("profileBio").value.trim(),updatedAt:serverTimestamp()
    },{merge:true});
  });
}

async function savePublicProfile() {
  const username=normalizeUsername($("profileUsername").value);
  await setDoc(doc(db,"publicProfiles",currentUser.uid),{
    uid:currentUser.uid,username,usernameLower:username,
    displayName:$("profileName").value.trim(),photoURL:currentPhotoURL||"",
    bio:$("profileBio").value.trim(),updatedAt:serverTimestamp()
  },{merge:true});
}

onAuthStateChanged(auth, async user=>{
  if(!user){location.replace("login.html");return;}
  currentUser=user;
  setProfileStatus("Loading profile…");
  try{
    const snap=await getDoc(doc(db,"users",user.uid));
    const data=snap.exists()?snap.data():{};
    const name=data.name||user.displayName||"";
    currentPhotoURL=data.photoURL||user.photoURL||"";
    const username=normalizeUsername(data.username||"");
    originalProfile={name,username,bio:data.bio||"",photoURL:currentPhotoURL,retention:data.retentionMode||"24hours"};
    $("profileName").value=name;
    $("profileEmail").value=user.email||data.email||"";
    $("profileUsername").value=username;
    if(!username) $("profileUsername").placeholder=suggestUsername(name,user.email);
    $("profileBio").value=data.bio||"";
    updateBioCount(); updateIdentityPreview();
    paintAvatar($("profileAvatar"),{photoURL:currentPhotoURL,name,email:user.email,preset:"avatarXl"});
    const retention=await loadRetentionMode(user.uid);
    const radio=document.querySelector(`input[name="retention"][value="${retention}"]`);
    if(radio)radio.checked=true;
    $("soundToggle").checked=isSoundEnabled();
    setProfileStatus("");
  }catch(e){console.error("Profile load error:",e);setProfileStatus("Could not load your profile. Please refresh.","error");}
});

$("profileName")?.addEventListener("input",updateIdentityPreview);
$("profileUsername")?.addEventListener("input",()=>{
  updateIdentityPreview();
  clearTimeout(usernameTimer);
  usernameTimer=setTimeout(()=>checkUsernameAvailability($("profileUsername").value),500);
});
$("profileBio")?.addEventListener("input",updateBioCount);
$("changePhotoBtn")?.addEventListener("click",openPhotoPicker);
$("avatarButton")?.addEventListener("click",openPhotoPicker);

$("photoInput")?.addEventListener("change",async()=>{
  const file=$("photoInput").files?.[0]; $("photoInput").value="";
  if(!file||!currentUser)return;
  uploadController?.abort(); uploadController=new AbortController();
  const previous=currentPhotoURL;
  const objectUrl=URL.createObjectURL(file);
  const avatar=$("profileAvatar"), img=avatar?.querySelector("img"), fallback=avatar?.querySelector(".avatar-fallback");
  if(img){img.src=objectUrl;img.hidden=false;img.style.display="block";} if(fallback){fallback.hidden=true;fallback.style.display="none";}
  const stage=$("profileAvatar").closest(".profile-hero-avatar"); stage?.classList.add("uploading");
  $("uploadStatus").textContent="Uploading photo…"; $("uploadProgressFill").style.width="0%";
  try{
    const url=await uploadImageToCloudinary(file,{signal:uploadController.signal,onProgress:p=>$("uploadProgressFill").style.width=`${Math.round(p*100)}%`});
    currentPhotoURL=url;
    await updateProfile(currentUser,{photoURL:url});
    await updateDoc(doc(db,"users",currentUser.uid),{photoURL:url,lastSeen:serverTimestamp()});
    await savePublicProfile();
    paintAvatar(avatar,{photoURL:url,name:$("profileName").value,email:currentUser.email,preset:"avatarXl"});
    $("uploadStatus").textContent="Profile photo updated ✓"; playSuccess(); showToast("Profile photo updated.","success");
  }catch(e){
    if(e?.kind==="aborted")return;
    console.error("Photo upload failed:",e);
    $("uploadStatus").textContent=e instanceof UploadError?e.userMessage:"Couldn't upload image.";
    paintAvatar(avatar,{photoURL:previous,name:$("profileName").value,email:currentUser.email,preset:"avatarXl"});
    showToast($("uploadStatus").textContent,"error");
  }finally{
    URL.revokeObjectURL(objectUrl); stage?.classList.remove("uploading");
    setTimeout(()=>{$("uploadStatus").textContent="";$("uploadProgressFill").style.width="0%"},2200);
  }
});

$("backToChat")?.addEventListener("click",()=>{playClick();location.href="index.html";});
$("cancelProfileBtn")?.addEventListener("click",()=>{playClick();location.href="index.html";});
$("themeProfileBtn")?.addEventListener("click",()=>{
  const next=document.documentElement.dataset.theme==="dark"?"light":"dark";
  document.documentElement.dataset.theme=next;localStorage.setItem("cunnact_theme",next);playClick();
});
$("soundToggle")?.addEventListener("change",e=>{setSoundEnabled(e.target.checked);if(e.target.checked)playClick();showToast(e.target.checked?"Sound effects on":"Sound effects off","success");});
document.querySelectorAll('input[name="retention"]').forEach(r=>r.addEventListener("change",async e=>{
  if(!currentUser)return; try{await setRetentionMode(e.target.value,currentUser.uid);showToast(e.target.value==="seen"?"Messages will delete after seen":"Messages will delete after 24 hours","success");}catch(err){console.error(err);showToast("Could not save retention setting","error");}
}));

$("shareProfileBtn")?.addEventListener("click",async()=>{
  const username=normalizeUsername($("profileUsername").value);
  if(!username){showToast("Set a CUNNACT ID before sharing your profile.","info");$("profileUsername").focus();return;}
  const url=`${location.origin}/u/${encodeURIComponent(username)}`;
  const text=`Connect with me on CUNNACT:\n@${username}`;
  try{
    if(navigator.share){await navigator.share({title:"CUNNACT profile",text,url});}
    else await navigator.clipboard.writeText(url);
    showToast("CUNNACT profile link copied ✓","success");
  }catch(e){if(e?.name!=="AbortError"){try{await navigator.clipboard.writeText(url);showToast("Profile link copied ✓","success");}catch{showToast("Copy failed. Use the profile URL manually.","error");}}}
});

$("profileForm")?.addEventListener("submit",async e=>{
  e.preventDefault(); if(!currentUser)return;
  const name=$("profileName").value.trim(), username=normalizeUsername($("profileUsername").value), oldUsername=originalProfile.username||"";
  if(!name){setProfileStatus("Please enter your name.","error");$("profileName").focus();return;}
  if(!username){setProfileStatus("Choose a CUNNACT ID first.","error");$("profileUsername").focus();return;}
  if(!usernamePattern.test(username)||RESERVED.has(username)){setProfileStatus("Choose a valid CUNNACT ID.","error");$("profileUsername").focus();return;}
  const button=e.currentTarget.querySelector('button[type="submit"]'); const original=button.textContent; button.disabled=true;button.textContent="Saving…";
  try{
    if(username!==oldUsername) await claimUsername(username,oldUsername);
    await updateProfile(currentUser,{displayName:name});
    await updateDoc(doc(db,"users",currentUser.uid),{name,email:currentUser.email||"",emailLower:String(currentUser.email||"").toLowerCase(),bio:$("profileBio").value.trim(),username,usernameLower:username,retentionMode:getRetentionMode(),lastSeen:serverTimestamp()});
    await savePublicProfile();
    originalProfile={name,username,bio:$("profileBio").value.trim(),photoURL:currentPhotoURL,retention:getRetentionMode()};
    updateIdentityPreview(); setProfileStatus("Changes saved ✓","success");playSuccess();showToast("Profile updated ✓","success");
  }catch(err){
    console.error("Profile save error:",err);
    setProfileStatus(err?.message==="USERNAME_TAKEN"?"That CUNNACT ID is already taken.":"Could not save your profile. Please try again.","error");
  }finally{button.disabled=false;button.textContent=original;}
});
