import { auth, db, doc, getDoc, onAuthStateChanged } from "./firebase.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";

const state = document.getElementById("publicState");
const routePart = location.pathname.split("/").filter(Boolean).at(-1) || "";
const queryPart = new URLSearchParams(location.search).get("username") || "";
const username = decodeURIComponent(queryPart || routePart).replace(/^@+/, "").toLowerCase();
let loadedProfile = null;
let authUser = null;

function publicUrl(u){ return `${location.origin}/u/${encodeURIComponent(u)}`; }
function escapeText(value){const el=document.createElement("textarea");el.textContent=String(value??"");return el.innerHTML;}
function renderLoading(){state.innerHTML='<div class="public-state"><span class="spinner-ring"></span><p>Loading profile…</p></div>';}
function render(profile){
  if(!profile){state.innerHTML='<div class="public-state"><div class="public-not-found-mark">?</div><h2>Profile not found</h2><p>This CUNNACT ID does not exist or is no longer public.</p><a class="btn btn-primary" href="index.html">Go to CUNNACT</a></div>';return;}
  loadedProfile=profile;
  const name=profile.displayName||"CUNNACT user", username=profile.username||username;
  state.innerHTML=`<div class="avatar public-user-avatar" id="publicAvatar"><img alt="" hidden><span class="avatar-fallback" hidden></span></div><div class="public-online-badge"><span></span> CUNNACT profile</div><h1 class="public-name"></h1><div class="public-username">@${escapeText(username)}</div><p class="public-bio">${escapeText(profile.bio||"")}</p><div class="public-actions"><button id="publicPrimary" class="btn btn-primary" type="button"></button><button id="copyPublicId" class="btn btn-soft" type="button">Copy CUNNACT ID</button></div><button id="sharePublic" class="public-link-button" type="button">Share profile link</button><p class="public-private-note">Only public profile information is shown here. Your email and private settings stay private.</p>`;
  state.querySelector(".public-name").textContent=name;
  paintAvatar(state.querySelector("#publicAvatar"),{photoURL:profile.photoURL,name,email:""});
  updatePrimary();
  state.querySelector("#copyPublicId").onclick=async()=>{try{await navigator.clipboard.writeText(`@${username}`);showToast("CUNNACT ID copied ✓","success");}catch{showToast(`CUNNACT ID: @${username}`,"info");}};
  state.querySelector("#sharePublic").onclick=async()=>{const url=publicUrl(username),text=`Connect with me on CUNNACT:\n@${username}`;try{if(navigator.share)await navigator.share({title:`${name} · CUNNACT`,text,url});else{await navigator.clipboard.writeText(url);showToast("Profile link copied ✓","success");}}catch(e){if(e.name!=="AbortError")showToast("Could not share profile link","error");}};
}
function updatePrimary(){const b=document.getElementById("publicPrimary");if(!b||!loadedProfile)return;if(authUser?.uid===loadedProfile.uid){b.textContent="Edit Profile";b.onclick=()=>location.href="index.html#profile";}else if(authUser){b.textContent="Open CUNNACT";b.onclick=()=>location.href=`index.html?newChat=@${encodeURIComponent(loadedProfile.username)}`;}else{b.textContent="Login to message";b.onclick=()=>location.href="login.html";}}
async function load(){
  if(!username){render(null);return;}
  renderLoading();
  try{const map=await getDoc(doc(db,"usernames",username));if(!map.exists()){render(null);return;}const uid=map.data()?.uid;if(!uid){render(null);return;}const snap=await getDoc(doc(db,"publicProfiles",uid));render(snap.exists()?snap.data():null);}catch(e){console.error("Public profile load failed",e);state.innerHTML='<div class="public-state"><h2>Could not load profile</h2><p>Please check your connection and try again.</p><button class="btn btn-primary" id="retryPublicProfile">Try again</button></div>';document.getElementById("retryPublicProfile")?.addEventListener("click",load);}}
// Public profile fetch is independent of auth. Auth only changes the action button.
load();
onAuthStateChanged(auth,user=>{authUser=user;updatePrimary();});
