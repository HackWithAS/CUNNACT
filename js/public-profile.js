import { auth, db, doc, getDoc, onAuthStateChanged } from "./firebase.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";

const state=document.getElementById("publicState");
const pathUsername=location.pathname.split("/").filter(Boolean).pop()||"";
const queryUsername=new URLSearchParams(location.search).get("username")||"";
const username=decodeURIComponent(queryUsername||pathUsername).replace(/^@/,"").toLowerCase();

function render(profile,user){
  if(!profile){state.innerHTML='<div class="public-state"><h2>Profile not found</h2><p>This CUNNACT ID does not exist or is no longer public.</p><a class="btn btn-primary" href="index.html">Go to CUNNACT</a></div>';return;}
  const safeName=profile.displayName||"CUNNACT user";
  state.innerHTML=`
    <div class="avatar public-user-avatar"><img alt="" hidden><span class="avatar-fallback" hidden></span></div>
    <h1 class="public-name"></h1>
    <div class="public-username">@${profile.username}</div>
    <p class="public-bio">${String(profile.bio||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}</p>
    <div class="public-actions">
      <button id="publicPrimary" class="btn btn-primary" type="button"></button>
      <button id="copyPublicId" class="btn btn-soft" type="button">Copy CUNNACT ID</button>
    </div>
    <p class="public-private-note">Only public profile information is shown here. Your email and private settings stay private.</p>`;
  state.querySelector(".public-name").textContent=safeName;
  paintAvatar(state.querySelector(".avatar"),{photoURL:profile.photoURL,name:safeName,preset:"avatarXl"});
  const primary=state.querySelector("#publicPrimary");
  if(user?.uid===profile.uid){primary.textContent="Edit Profile";primary.onclick=()=>location.href="profile.html";}
  else if(user){primary.textContent="Open CUNNACT";primary.onclick=()=>location.href="index.html?newChat="+encodeURIComponent(profile.username);}
  else {primary.textContent="Login to message";primary.onclick=()=>location.href="login.html";}
  state.querySelector("#copyPublicId").onclick=async()=>{try{await navigator.clipboard.writeText(`@${profile.username}`);showToast("CUNNACT ID copied ✓","success");}catch{showToast(`CUNNACT ID: @${profile.username}`,"info");}};
}

async function load(user){
  if(!username){render(null,user);return;}
  try{
    const map=await getDoc(doc(db,"usernames",username));
    if(!map.exists()){render(null,user);return;}
    const uid=map.data()?.uid;
    const snap=await getDoc(doc(db,"publicProfiles",uid));
    render(snap.exists()?snap.data():null,user);
  }catch(e){console.error("Public profile load failed:",e);state.innerHTML='<div class="public-state"><h2>Could not load profile</h2><p>Please try again.</p></div>';}
}
onAuthStateChanged(auth,user=>load(user));
