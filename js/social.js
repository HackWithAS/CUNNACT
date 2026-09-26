import {
  db, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp, arrayUnion, arrayRemove, onSnapshot
} from "./firebase.js";
import { uploadFileToCloudinary, validateMediaFile, mediaKind } from "./cloudinary.js";
import { escapeHtml, formatTime } from "./ui.js";
import { showToast } from "./toast.js";
import { notifyBrowser } from "./notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function safeTime(value) {
  return value?.toDate?.() || (value instanceof Date ? value : (value ? new Date(value) : null));
}
function isExpired(data) {
  const expires = safeTime(data?.expiresAt);
  return !!expires && expires.getTime() <= Date.now();
}
function storyText(story) {
  if (story.type === "image") return "📷 Photo";
  if (story.type === "video") return "🎬 Video";
  if (story.type === "poll") return "📊 Poll";
  return story.text || "Trace";
}
function visibilityLabel(value) {
  return value === "public" ? "Public" : value === "closeFriends" ? "Close friends" : "Selected people";
}
function fileAccept(kind) {
  return kind === "image" ? "image/jpeg,image/png,image/webp,image/gif" : "video/mp4,video/webm,video/quicktime";
}
function isTrustedLink(value) {
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol); } catch { return false; }
}
function linkHost(value) { try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; } }

export function initSocialFeatures({ getCurrentUser }) {
  let socialBound = false;
  let stories = [];
  let communities = [];
  let channels = [];
  let activeCommunity = null;
  let activeChannel = null;
  let storyUnsub = null;
  let communityUnsub = null;
  let channelUnsub = null;
  let storyCursor = 0;
  let storyCandidates = [];
  let storyNotificationInitialized = false;
  let knownStoryIds = new Set();
  let traceMode = "text";
  let traceAudienceDefault = "public";
  let traceBackgroundIndex = 0;
  let myTraceCache = [];
  const traceBackgrounds = [
    "linear-gradient(135deg,#263238,#34495e)",
    "linear-gradient(135deg,#203a43,#2c5364)",
    "linear-gradient(135deg,#40234f,#82458b)",
    "linear-gradient(135deg,#0f2027,#203a43,#2c5364)",
    "linear-gradient(135deg,#2b5876,#4e4376)",
    "linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b)"
  ];

  const user = () => getCurrentUser?.();
  const $ = id => document.getElementById(id);
  const openModal = id => { const el=$(id); if(!el)return; el.hidden=false; el.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open"); };
  const closeModal = id => { const el=$(id); if(!el)return; if(el.contains(document.activeElement) && typeof document.activeElement?.blur === "function") document.activeElement.blur(); el.hidden=true; el.setAttribute("aria-hidden","true"); if(!document.querySelector(".modal:not([hidden])"))document.body.classList.remove("modal-open"); };

  function traceShell(){ return document.querySelector("#storyComposerModal .trace-composer-shell"); }
  function traceText(){ return $("storyTextInput"); }
  function syncTraceComposer(){
    const shell=traceShell(), input=traceText(); if(!shell||!input)return;
    shell.style.background=traceBackgrounds[traceBackgroundIndex % traceBackgrounds.length];
    input.classList.toggle("is-large",input.dataset.traceStyle==="large");
    input.classList.toggle("is-script",input.dataset.traceStyle==="script");
    $("traceAudienceLabel") && ($("traceAudienceLabel").textContent = ({public:"Everyone",closeFriends:"Close friends",custom:"Selected people"}[$("storyPrivacy")?.value||"public"]||"Everyone"));
  }
  function resetTraceComposer(){
    ["storyTextInput","storyStickerInput","storyLinkInput","storyPollQuestion","storyPollOptions"].forEach(id=>{const el=$(id);if(el)el.value="";});
    if($("storyMediaInput"))$("storyMediaInput").value="";
    if($("storyPrivacy"))$("storyPrivacy").value=traceAudienceDefault;
    if($("traceMediaPreview")){ $("traceMediaPreview").hidden=true; $("traceMediaPreview").innerHTML=""; }
    if($("traceToolsPanel"))$("traceToolsPanel").hidden=true;
    if($("traceEmojiPanel"))$("traceEmojiPanel").hidden=true;
    if($("storyTextInput")){ $("storyTextInput").dataset.traceStyle="normal"; }
    traceBackgroundIndex=0; syncTraceComposer();
  }
  function openTraceComposer(mode="text") {
    const modal=$("storyComposerModal"); if(!modal)return;
    resetTraceComposer(); traceMode=mode; modal.hidden=false; renderStoryAudiencePicker(); modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open","trace-compose-open"); syncTraceComposer();
    if(mode==="media"){ setTimeout(()=>$("storyMediaInput")?.click(),90); } else { setTimeout(()=>$("storyTextInput")?.focus(),90); }
  }
  function syncTraceMediaPreview(){
    const input=$("storyMediaInput"),box=$("traceMediaPreview"),text=$("storyTextInput"); if(!input||!box)return; const file=input.files?.[0];
    if(!file){box.hidden=true;box.innerHTML="";if(text)text.classList.remove("with-media");return;}
    const url=URL.createObjectURL(file); const video=/^video\//.test(file.type);
    box.hidden=false; box.innerHTML=video?`<video src="${url}" controls autoplay muted playsinline></video>`:`<img src="${url}" alt="Trace preview">`; if(text)text.classList.add("with-media");
  }
  function openTracePrivacy(){
    const current=$("storyPrivacy")?.value||"public"; document.querySelectorAll('input[name="tracePrivacyOption"]').forEach(r=>r.checked=r.value===current); renderStoryAudiencePicker(); openModal("tracePrivacyModal");
  }
  function closeTracePrivacy(){ closeModal("tracePrivacyModal"); }
  function setupTracePrivacyInputs(){
    document.querySelectorAll('input[name="tracePrivacyOption"]').forEach(r=>r.addEventListener("change",()=>{if($("storyPrivacy"))$("storyPrivacy").value=r.value;renderStoryAudiencePicker();syncTraceComposer();}));
  }
  function appendTraceEmoji(emoji){ const input=$("storyTextInput"); if(!input)return; const start=input.selectionStart??input.value.length,end=input.selectionEnd??input.value.length;input.value=input.value.slice(0,start)+emoji+input.value.slice(end);input.focus();input.setSelectionRange(start+emoji.length,start+emoji.length); }

  async function fetchStories() {
    const u=user(); if(!u)return [];
    const base = collection(db,"stories");
    const now=new Date();
    const snaps=[];
    try { snaps.push(await getDocs(query(base,where("ownerId","==",u.uid),where("expiresAt",">",now),limit(80)))); } catch {}
    try { snaps.push(await getDocs(query(base,where("privacy","==","public"),where("expiresAt",">",now),limit(80)))); } catch {}
    try { snaps.push(await getDocs(query(base,where("privacy","==","custom"),where("audienceIds","array-contains",u.uid),where("expiresAt",">",now),limit(80)))); } catch {}
    try { snaps.push(await getDocs(query(base,where("privacy","==","closeFriends"),where("closeFriendsIds","array-contains",u.uid),where("expiresAt",">",now),limit(80)))); } catch {}
    const map=new Map();snaps.flatMap(s=>s.docs).forEach(d=>{const item={id:d.id,...d.data()};if(!isExpired(item))map.set(d.id,item);});
    stories=[...map.values()].sort((a,b)=>(safeTime(b.createdAt)?.getTime()||0)-(safeTime(a.createdAt)?.getTime()||0));
    if(storyNotificationInitialized){
      stories.filter(story=>!knownStoryIds.has(story.id)&&story.ownerId!==u.uid).slice(0,10).forEach(story=>{
        notifyBrowser({category:"status",title:story.ownerName||"New status",body:storyText(story),conversationId:`status-${story.id}`});
      });
    }
    knownStoryIds=new Set(stories.map(story=>story.id));
    storyNotificationInitialized=true;
    return stories;
  }

  function renderStoryList() {
    const box=$("storiesList");
    const strip=$("storiesStripDynamic");
    if(!box && !strip) return;
    if(!stories.length){
      if(box) box.innerHTML='<div class="social-empty"><div class="social-empty-icon">✨</div><strong>No active stories</strong><span>Share a photo, video, thought or poll that disappears in 24 hours.</span></div>';
      if(strip) strip.innerHTML="";
      return;
    }
    const grouped=new Map();
    stories.forEach(s=>{if(!grouped.has(s.ownerId))grouped.set(s.ownerId,[]);grouped.get(s.ownerId).push(s);});
    if(box){
      box.innerHTML=[...grouped.entries()].map(([ownerId,list])=>{
        const first=list[0],mine=ownerId===user()?.uid,name=mine?"Your trace":(first.ownerName||"CUNNACT user");
        const avatar=first.ownerPhotoURL?`<img src="${escapeHtml(first.ownerPhotoURL)}" alt="">`:`<span>${escapeHtml(name.slice(0,1).toUpperCase())}</span>`;
        return `<button class="story-card ${list.some(s=>!(s.viewers||[]).includes(user()?.uid))?"unseen":"seen"}" data-story-owner="${escapeHtml(ownerId)}" type="button">
          <span class="story-avatar">${avatar}</span><span class="story-owner-name">${escapeHtml(name)}</span><small>${list.length} ${list.length===1?"story":"stories"}</small>
        </button>`;
      }).join("");
      box.querySelectorAll("[data-story-owner]").forEach(btn=>btn.addEventListener("click",()=>openStoryViewer(btn.dataset.storyOwner)));
    }
    if(strip){
      strip.innerHTML=[...grouped.entries()].filter(([ownerId])=>ownerId!==user()?.uid).slice(0,10).map(([ownerId,list])=>{
        const first=list[0],name=(first.ownerName||"CUNNACT user");
        const unseen=list.some(s=>!(s.viewers||[]).includes(user()?.uid));
        const avatar=first.ownerPhotoURL?`<img src="${escapeHtml(first.ownerPhotoURL)}" alt="">`:`<span>${escapeHtml(name.slice(0,1).toUpperCase())}</span>`;
        return `<button type="button" class="story-chip" data-story-owner="${escapeHtml(ownerId)}">
          <span class="story-ring ${unseen?"":"seen"}"><span class="story-ring-inner">${avatar}</span></span>
          <small>${escapeHtml(name.split(" ")[0])}</small>
        </button>`;
      }).join("");
      strip.querySelectorAll("[data-story-owner]").forEach(btn=>btn.addEventListener("click",()=>openStoryViewer(btn.dataset.storyOwner)));
    }
  }

  async function markStoryViewed(story) {
    const u=user(); if(!u || story.ownerId===u.uid)return;
    try { await setDoc(doc(db,"stories",story.id,"viewers",u.uid),{uid:u.uid,viewedAt:serverTimestamp()},{merge:true}); } catch(e){console.warn("Story view failed",e);}
  }
  async function storyReact(emoji) {
    const s=storyCandidates[storyCursor],u=user();if(!s||!u)return;
    try { await setDoc(doc(db,"stories",s.id,"reactions",u.uid),{uid:u.uid,emoji,createdAt:serverTimestamp()},{merge:true}); showToast("Reaction added","success"); } catch(e){showToast("Could not react to trace.","error");}
  }
  async function storyReply() {
    const s=storyCandidates[storyCursor],u=user(),input=$("storyReplyInput");if(!s||!u||!input)return;
    const text=input.value.trim();if(!text)return;
    try { await addDoc(collection(db,"stories",s.id,"replies"),{senderId:u.uid,senderName:u.displayName||"CUNNACT user",text:text.slice(0,500),createdAt:serverTimestamp()});input.value="";showToast("Reply sent","success"); } catch(e){showToast("Could not reply to trace.","error");}
  }
  function renderStoryViewer() {
    const s=storyCandidates[storyCursor];if(!s)return;
    $("storyViewerTitle").textContent=s.ownerId===user()?.uid?"Your trace":(s.ownerName||"Trace");
    $("storyViewerMeta").textContent=`${storyCursor+1} / ${storyCandidates.length} · ${visibilityLabel(s.privacy)}${safeTime(s.createdAt)?` · ${formatTime(safeTime(s.createdAt))}`:""}`;
    const body=$("storyViewerBody");
    const media=s.mediaURL&&((s.type==="image")||s.type==="video") ? (s.type==="video"?`<video src="${escapeHtml(s.mediaURL)}" controls autoplay playsinline></video>`:`<img src="${escapeHtml(s.mediaURL)}" alt="Story">`) : "";
    const text=s.text?`<p class="story-viewer-text">${escapeHtml(s.text)}</p>`:"";
    const sticker=s.sticker?`<div class="story-viewer-sticker">${escapeHtml(s.sticker)}</div>`:"";
    const link=s.linkUrl?`<a class="story-viewer-link" href="${escapeHtml(s.linkUrl)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(s.linkHost||linkHost(s.linkUrl))}</a>`:"";
    let poll="";
    if(s.type==="poll"&&Array.isArray(s.pollOptions))poll=`<div class="story-poll"><strong>${escapeHtml(s.pollQuestion||"Poll")}</strong>${s.pollOptions.map((o,i)=>`<button type="button" data-story-vote="${i}">${escapeHtml(o)} <small>${Number(s.pollCounts?.[i]||0)}</small></button>`).join("")}</div>`;
    body.innerHTML=`${media}${text}${sticker}${link}${poll}<div class="story-viewer-tools"><span>❤️ React</span><span>👁 ${Number(s.viewerCount||Object.keys(s.viewers||{}).length||0)}</span></div>`;
    body.querySelectorAll("[data-story-vote]").forEach(btn=>btn.addEventListener("click",()=>voteStory(Number(btn.dataset.storyVote))));
    const progress=$("traceViewerProgress");if(progress){progress.innerHTML=storyCandidates.map((_,i)=>`<span class="${i<storyCursor?"done":i===storyCursor?"active":""}"></span>`).join("");}
    $("storyPrevBtn").disabled=storyCursor<=0;$("storyNextBtn").disabled=storyCursor>=storyCandidates.length-1;$("storyPrevBtn").style.visibility=storyCandidates.length>1?"visible":"hidden";$("storyNextBtn").style.visibility=storyCandidates.length>1?"visible":"hidden";
  }
  async function voteStory(index){const s=storyCandidates[storyCursor],u=user();if(!s||!u||s.type!=="poll")return;try{const ref=doc(db,"stories",s.id),snap=await getDoc(ref),data=snap.data()||{},votes={...(data.pollVotes||{})},counts={...(data.pollCounts||{})};const old=votes[u.uid];if(old!==undefined&&Number(old)===index)return; if(old!==undefined)counts[old]=Math.max(0,Number(counts[old]||0)-1);votes[u.uid]=index;counts[index]=Number(counts[index]||0)+1;await updateDoc(ref,{pollVotes:votes,pollCounts:counts});storyCandidates[storyCursor]={...s,pollVotes:votes,pollCounts:counts};renderStoryViewer();showToast("Vote saved","success");}catch(e){showToast("Could not save poll vote.","error");}}
  async function openStoryViewer(ownerId){
    const u=user();
    storyCandidates=stories.filter(s=>s.ownerId===ownerId&&!isExpired(s));
    if(u&&ownerId===u.uid&&!storyCandidates.length)storyCandidates=myTraceCache.filter(s=>!isExpired(s));
    if(!storyCandidates.length){showToast(ownerId===u?.uid?"You have no active traces yet.":"That trace is no longer available.","info");return;}
    storyCursor=0;await markStoryViewed(storyCandidates[0]);openModal("storyViewerModal");renderStoryViewer();
    try{await fetchStories();if(u&&ownerId===u.uid){const refreshed=stories.filter(s=>s.ownerId===ownerId&&!isExpired(s));if(refreshed.length){storyCandidates=refreshed;renderStoryViewer();}}}catch{}
  }
  async function renderStoryAudiencePicker() {
    const wrap=$("storyAudiencePickerWrap"),box=$("storyAudiencePicker");if(!wrap||!box)return;const privacy=$("storyPrivacy")?.value||"public";if(privacy==="public"){wrap.hidden=true;return;}wrap.hidden=false;box.innerHTML='<div class="empty-state">Loading contacts…</div>';const contacts=await getConnectedUsers();if(!contacts.length){box.innerHTML='<div class="empty-state">You need connected contacts to choose an audience.</div>';return;}box.innerHTML=contacts.map(c=>`<label class="checkbox-line"><input type="checkbox" value="${escapeHtml(c.uid)}"><span>${escapeHtml(c.name||c.email||"Contact")}</span></label>`).join("");}

  async function createStory() {
    const u=user();if(!u)return;
    const text=$("storyTextInput")?.value.trim()||"";const file=$("storyMediaInput")?.files?.[0]||null;const privacy=$("storyPrivacy")?.value||"public";
    const sticker=$("storyStickerInput")?.value.trim()||"";const linkUrl=$("storyLinkInput")?.value.trim()||"";const pollQuestion=$("storyPollQuestion")?.value.trim()||"";const pollOptions=($("storyPollOptions")?.value||"").split("\n").map(x=>x.trim()).filter(Boolean).slice(0,6);
    if(!text&&!file&&!sticker&&!linkUrl&&!pollQuestion){showToast("Add text, media, sticker, link or poll.","error");return;}
    if(linkUrl&&!isTrustedLink(linkUrl)){showToast("Use a valid http/https link.","error");return;}
    if(pollQuestion&&pollOptions.length<2){showToast("A poll needs at least 2 options.","error");return;}
    const btn=$("publishStoryBtn");if(btn){btn.disabled=true;btn.textContent="Publishing…";}
    try{
      let mediaURL="",type="text";
      if(file){const kind=await validateMediaFile(file);mediaURL=await uploadFileToCloudinary(file,{});type=kind==="video"?"video":"image";}
      if(pollQuestion)type="poll";
      let closeFriendsIds=[];let audienceIds=[];
      if(privacy!=="public"){
        const selected=[...document.querySelectorAll('#storyAudiencePicker input[type="checkbox"]:checked')].map(x=>x.value).slice(0,50);
        if(!selected.length)throw new Error("STORY_AUDIENCE_REQUIRED");
        if(privacy==="closeFriends")closeFriendsIds=selected;
        if(privacy==="custom")audienceIds=selected;
      }
      const expiresAt=new Date(Date.now()+DAY_MS);
      const createdAt=new Date();
      const payload={ownerId:u.uid,ownerName:u.displayName||"CUNNACT user",ownerPhotoURL:u.photoURL||"",type,text:text.slice(0,2000),mediaURL,privacy,closeFriendsIds,audienceIds,sticker:sticker.slice(0,120),linkUrl,linkHost:linkHost(linkUrl),pollQuestion:pollQuestion.slice(0,250),pollOptions,pollVotes:{},pollCounts:{},createdAt:serverTimestamp(),expiresAt};
      const ref=await addDoc(collection(db,"stories"),payload);
      const localStory={id:ref.id,...payload,createdAt};
      myTraceCache=[localStory,...myTraceCache.filter(x=>x.id!==localStory.id)];
      stories=[localStory,...stories.filter(x=>x.id!==localStory.id)];
      ["storyTextInput","storyStickerInput","storyLinkInput","storyPollQuestion","storyPollOptions"].forEach(id=>{if($(id))$(id).value="";});if($("storyMediaInput"))$("storyMediaInput").value="";
      closeModal("storyComposerModal");
      renderStatusPage();
      renderStoryList();
      try{await fetchStories();renderStatusPage();renderStoryList();}catch{}
      showToast("Trace published for 24 hours","success");
    }catch(e){console.error("Story publish failed",e);showToast(e?.message==="STORY_AUDIENCE_REQUIRED"?"Choose at least one person for this story.":(e?.userMessage||"Could not publish your trace."),"error");}
    finally{if(btn){btn.disabled=false;btn.textContent="Publish story";}}
  }

  async function getConnectedUsers(){
    const u=user();if(!u)return [];
    try{
      const snap=await getDocs(query(collection(db,"conversations"),where("members","array-contains",u.uid),limit(100)));
      const ids=new Set();snap.docs.forEach(d=>{const c=d.data();if(c.type!=="group"){const other=(c.members||[]).find(id=>id!==u.uid);if(other)ids.add(other);}});
      const out=[];for(const id of ids){try{const s=await getDoc(doc(db,"users",id));if(s.exists())out.push({uid:id,...s.data()});}catch{}}
      return out;
    }catch{return []}
  }

  async function fetchCommunities(){
    const u=user();if(!u)return;
    const snaps=[];
    try{snaps.push(await getDocs(query(collection(db,"communities"),where("privacy","==","public"),limit(80))));}catch{}
    try{snaps.push(await getDocs(query(collection(db,"communities"),where("memberIds","array-contains",u.uid),limit(80))));}catch{}
    const map=new Map();snaps.flatMap(s=>s.docs).forEach(d=>map.set(d.id,{id:d.id,...d.data()}));communities=[...map.values()].sort((a,b)=>(safeTime(b.createdAt)?.getTime()||0)-(safeTime(a.createdAt)?.getTime()||0));renderCommunityList();
  }
  async function openCommunityJoinRequests(){
    if(!activeCommunity||!(activeCommunity.adminIds||[]).includes(user()?.uid))return;const box=$("communityJoinRequestsList");if(!box)return;box.innerHTML='<div class="empty-state">Loading requests…</div>';openModal("communityJoinRequestsModal");try{const snap=await getDocs(query(collection(db,"communities",activeCommunity.id,"joinRequests"),limit(50)));const rows=snap.docs.map(d=>({id:d.id,...d.data()}));box.innerHTML=rows.length?rows.map(r=>`<div class="social-list-card"><div class="social-card-main"><div class="social-icon">👤</div><div><strong>${escapeHtml(r.name||"User")}</strong><small>Requested ${safeTime(r.createdAt)?escapeHtml(formatTime(safeTime(r.createdAt))):"recently"}</small></div></div><div class="social-card-actions"><button type="button" class="btn btn-primary btn-sm" data-community-approve="${escapeHtml(r.uid||r.id)}">Approve</button><button type="button" class="btn btn-soft btn-sm" data-community-reject="${escapeHtml(r.uid||r.id)}">Reject</button></div></div>`).join(""):'<div class="empty-state">No pending requests.</div>';box.querySelectorAll("[data-community-approve]").forEach(b=>b.addEventListener("click",()=>reviewCommunityJoin(b.dataset.communityApprove,true)));box.querySelectorAll("[data-community-reject]").forEach(b=>b.addEventListener("click",()=>reviewCommunityJoin(b.dataset.communityReject,false)));}catch(e){box.innerHTML='<div class="empty-state">Could not load requests.</div>';}}
  async function reviewCommunityJoin(uid,approve){if(!activeCommunity||!(activeCommunity.adminIds||[]).includes(user()?.uid))return;try{if(approve)await updateDoc(doc(db,"communities",activeCommunity.id),{memberIds:arrayUnion(uid),updatedAt:serverTimestamp()});await updateDoc(doc(db,"communities",activeCommunity.id,"joinRequests",uid),{status:approve?"approved":"rejected",reviewedBy:user().uid,reviewedAt:serverTimestamp()});showToast(approve?"Member approved":"Request rejected",approve?"success":"info");await fetchCommunities();await openCommunityJoinRequests();}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked this review. Deploy the latest rules.":"Could not review request.","error");}}

  function renderCommunityList(filter=""){
    const box=$("communitiesList");if(!box)return;const term=String(filter||"").trim().toLowerCase();const list=communities.filter(c=>!term||String(c.nameLower||c.name||"").toLowerCase().includes(term)||String(c.description||"").toLowerCase().includes(term));
    if(!list.length){box.innerHTML='<div class="social-empty"><div class="social-empty-icon">👥</div><strong>No communities found</strong><span>Create one or search public communities.</span></div>';return;}
    box.innerHTML=list.map(c=>{const joined=(c.memberIds||[]).includes(user()?.uid);return `<div class="social-list-card"><div class="social-card-main"><div class="social-icon">👥</div><div><strong>${escapeHtml(c.name||"Community")}</strong><small>${escapeHtml(c.description||"No description")}</small><small>${Number((c.memberIds||[]).length)} members · ${c.privacy==="public"?"Public":"Private"}</small></div></div><div class="social-card-actions"><button type="button" class="btn btn-soft btn-sm" data-community-open="${escapeHtml(c.id)}">Open</button>${joined?"":`<button type="button" class="btn btn-primary btn-sm" data-community-join="${escapeHtml(c.id)}">Join</button>`}</div></div>`;}).join("");
    box.querySelectorAll("[data-community-open]").forEach(b=>b.addEventListener("click",()=>openCommunity(b.dataset.communityOpen)));box.querySelectorAll("[data-community-join]").forEach(b=>b.addEventListener("click",()=>joinCommunity(b.dataset.communityJoin)));
  }
  async function joinCommunity(id){const c=communities.find(x=>x.id===id);if(!c)return;const u=user();if(!u)return;try{if(c.privacy==="public"){await updateDoc(doc(db,"communities",id),{memberIds:arrayUnion(u.uid),updatedAt:serverTimestamp()});showToast("Joined community","success");}else{await setDoc(doc(db,"communities",id,"joinRequests",u.uid),{uid:u.uid,name:u.displayName||"CUNNACT user",createdAt:serverTimestamp()});showToast("Join request sent","success");}await fetchCommunities();}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked this join. Deploy the latest rules.":"Could not join community.","error");}}
  async function createCommunity(){
    const u=user();if(!u)return;const name=$("communityNameInput")?.value.trim();const description=$("communityDescriptionInput")?.value.trim()||"";const rules=$("communityRulesInput")?.value.trim()||"";const privacy=$("communityPrivacy")?.value||"public";if(name.length<2){showToast("Community name is too short.","error");return;}
    const btn=$("createCommunityBtn");if(btn)btn.disabled=true;try{const ref=await addDoc(collection(db,"communities"),{name:name.slice(0,80),nameLower:name.toLowerCase().slice(0,80),description:description.slice(0,500),rules:rules.slice(0,1200),privacy,ownerId:u.uid,adminIds:[u.uid],moderatorIds:[u.uid],memberIds:[u.uid],groupIds:[],channelIds:[],createdAt:serverTimestamp(),updatedAt:serverTimestamp()});const announcement=await addDoc(collection(db,"channels"),{name:"Announcements",nameLower:"announcements",description:`Official announcements for ${name.slice(0,60)}`,privacy,ownerId:u.uid,adminIds:[u.uid],subscriberIds:[u.uid],communityId:ref.id,isAnnouncement:true,maxAdmins:10,maxFollowers:0,settings:{comments:"followers",reactions:true},createdAt:serverTimestamp(),updatedAt:serverTimestamp()});await updateDoc(ref,{channelIds:[announcement.id],announcementChannelId:announcement.id,updatedAt:serverTimestamp()});closeModal("communityComposerModal");await fetchCommunities();await fetchChannels();await openCommunity(ref.id);showToast("Community created with an announcement channel","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked community creation. Deploy the latest rules.":"Could not create community.","error");}finally{if(btn)btn.disabled=false;}}

  async function openCommunity(id){
    activeCommunity=communities.find(c=>c.id===id);if(!activeCommunity){try{const s=await getDoc(doc(db,"communities",id));if(!s.exists())return;activeCommunity={id,...s.data()};}catch{return;}}
    $("communityDetailTitle").textContent=activeCommunity.name||"Community";$("communityDetailMeta").textContent=`${Number((activeCommunity.memberIds||[]).length)} members · ${activeCommunity.privacy==="public"?"Public":"Private"}`;$("communityDetailDescription").textContent=activeCommunity.description||"";const rulesBox=$("communityDetailRules"),rulesText=activeCommunity.rules||"";if(rulesBox){rulesBox.hidden=!rulesText;rulesBox.textContent=rulesText?`Rules
${rulesText}`:"";}const jr=$("communityJoinRequestsBtn");if(jr)jr.hidden=!((activeCommunity.adminIds||[]).includes(user()?.uid));
    openModal("communityDetailModal");await loadCommunityChildren();
  }
  async function loadCommunityChildren(){
    if(!activeCommunity)return;const groupsBox=$("communityGroupsList"),channelsBox=$("communityChannelsList");if(groupsBox)groupsBox.innerHTML='<div class="empty-state">Loading groups…</div>';if(channelsBox)channelsBox.innerHTML='<div class="empty-state">Loading channels…</div>';
    const groupIds=activeCommunity.groupIds||[];const channelIds=activeCommunity.channelIds||[];
    try{const groupDocs=await Promise.all(groupIds.slice(0,30).map(id=>getDoc(doc(db,"conversations",id)).catch(()=>null)));const groups=groupDocs.filter(s=>s?.exists?.()).map(s=>({id:s.id,...s.data()}));if(groupsBox)groupsBox.innerHTML=groups.length?groups.map(g=>`<div class="social-subitem"><div><strong>${escapeHtml(g.groupName||"Group")}</strong><small>${Number((g.members||[]).length)} members</small></div><button class="btn btn-soft btn-sm" data-open-group="${escapeHtml(g.id)}">Open chat</button></div>`).join(""):'<div class="empty-state">No sub-groups yet.</div>';groupsBox?.querySelectorAll("[data-open-group]").forEach(b=>b.addEventListener("click",()=>location.href=`index.html?conversation=${encodeURIComponent(b.dataset.openGroup)}`));}catch{}
    try{const chDocs=await Promise.all(channelIds.slice(0,30).map(id=>getDoc(doc(db,"channels",id)).catch(()=>null)));const ch=chDocs.filter(s=>s?.exists?.()).map(s=>({id:s.id,...s.data()}));if(channelsBox)channelsBox.innerHTML=ch.length?ch.map(c=>`<div class="social-subitem"><div><strong># ${escapeHtml(c.name||"Channel")}</strong><small>${Number((c.subscriberIds||[]).length)} followers</small></div><button class="btn btn-soft btn-sm" data-open-channel="${escapeHtml(c.id)}">Open</button></div>`).join(""):'<div class="empty-state">No channels yet.</div>';channelsBox?.querySelectorAll("[data-open-channel]").forEach(b=>b.addEventListener("click",()=>openChannel(b.dataset.openChannel)));}catch{}
  }

  async function createCommunityGroup(){
    if(!activeCommunity)return;const u=user();if(!u)return;const name=$("subgroupNameInput")?.value.trim();const description=$("subgroupDescriptionInput")?.value.trim()||"";const contacts=await getConnectedUsers();const selected=[...document.querySelectorAll('#subgroupMemberPicker input[type="checkbox"]:checked')].map(x=>x.value).filter(x=>x!==u.uid);if(selected.length<2){showToast("Pick at least 2 connected people for a group.","error");return;}const memberIds=[u.uid,...selected.slice(0,49)];try{const ref=doc(collection(db,"conversations"));await setDoc(ref,{type:"group",members:memberIds,createdBy:u.uid,groupName:name||`${activeCommunity.name} group`,groupDescription:description,groupPhotoURL:"",groupAdmins:[u.uid],groupModerators:[u.uid],groupRoles:Object.fromEntries(memberIds.map(id=>[id,id===u.uid?"admin":"member"])),joinApproval:true,unread:Object.fromEntries(memberIds.map(id=>[id,0])),lastMessage:"",lastMessageType:"text",lastMessageSenderId:"",lastMessageId:"",lastMessageTime:serverTimestamp(),createdAt:serverTimestamp(),communityId:activeCommunity.id},{});await updateDoc(doc(db,"communities",activeCommunity.id),{groupIds:arrayUnion(ref.id),updatedAt:serverTimestamp()});closeModal("subgroupComposerModal");showToast("Community group created","success");activeCommunity={...activeCommunity,groupIds:[...(activeCommunity.groupIds||[]),ref.id]};await loadCommunityChildren();}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked sub-group creation. Deploy the latest rules.":"Could not create sub-group.","error");}}
  function renderSubgroupPicker(){const box=$("subgroupMemberPicker");if(!box)return;getConnectedUsers().then(contacts=>{if(!contacts.length){box.innerHTML='<div class="empty-state">Start a few 1:1 chats before creating a community group.</div>';return;}box.innerHTML=contacts.map(c=>`<label class="checkbox-line"><input type="checkbox" value="${escapeHtml(c.uid)}"><span>${escapeHtml(c.name||c.email||"Contact")}</span></label>`).join("");});}

  async function fetchChannels(){
    const u=user();if(!u)return;const snaps=[];try{snaps.push(await getDocs(query(collection(db,"channels"),where("privacy","==","public"),limit(80))));}catch{}try{snaps.push(await getDocs(query(collection(db,"channels"),where("subscriberIds","array-contains",u.uid),limit(80))));}catch{}const map=new Map();snaps.flatMap(s=>s.docs).forEach(d=>map.set(d.id,{id:d.id,...d.data()}));channels=[...map.values()].sort((a,b)=>(safeTime(b.createdAt)?.getTime()||0)-(safeTime(a.createdAt)?.getTime()||0));renderChannelList();
  }
  function channelAvatarHtml(channel){
    const photo=channel?.photoURL||channel?.imageURL||channel?.avatarURL||"";
    return photo?`<img src="${escapeHtml(photo)}" alt="">`:`<span>${escapeHtml(String(channel?.name||"C").slice(0,1).toUpperCase())}</span>`;
  }
  function bindChannelListInteractions(box){
    if(!box)return;
    box.querySelectorAll("[data-channel-open]").forEach(b=>b.addEventListener("click",()=>openChannel(b.dataset.channelOpen)));
    box.querySelectorAll("[data-channel-follow]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();followChannel(b.dataset.channelFollow,true)}));
    box.querySelectorAll("[data-channel-unfollow]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();followChannel(b.dataset.channelUnfollow,false)}));
  }
  function renderChannelList(filter=""){
    const term=String(filter||"").trim().toLowerCase();
    const list=channels.filter(c=>!term||String(c.nameLower||c.name||"").toLowerCase().includes(term)||String(c.description||"").toLowerCase().includes(term));
    const boxes=[$("channelsList"),$("channelsViewList")].filter(Boolean);
    boxes.forEach(box=>{
      if(!list.length){box.innerHTML='<div class="channels-list-empty"><strong>No channels found</strong><span>Follow a channel or create your own.</span></div>';return;}
      const isDedicated=box.id==="channelsViewList";
      box.innerHTML=list.map(c=>{
        const followed=(c.subscriberIds||[]).includes(user()?.uid);const admin=(c.adminIds||[]).includes(user()?.uid);
        const title=escapeHtml(c.name||"Channel");
        const preview=escapeHtml(String(c.lastMessage||c.latestPost||c.description||"No updates yet"));
        const count=Number((c.subscriberIds||[]).length);
        if(isDedicated){
          return `<button type="button" class="channel-side-row ${activeChannel?.id===c.id?"active":""}" data-channel-open="${escapeHtml(c.id)}">
            <span class="channel-side-avatar">${channelAvatarHtml(c)}</span>
            <span class="channel-side-copy"><strong>${title}</strong><small>${preview}</small></span>
            <span class="channel-side-meta"><time>${safeTime(c.updatedAt||c.createdAt)?escapeHtml(formatTime(safeTime(c.updatedAt||c.createdAt))):""}</time>${Number(c.unreadCount||0)>0?`<b>${Number(c.unreadCount)}</b>`:""}</span>
          </button>`;
        }
        return `<div class="social-list-card"><div class="social-card-main"><div class="social-icon">📣</div><div><strong># ${title}</strong><small>${escapeHtml(c.description||"No description")}</small><small>${count} followers · ${c.privacy==="public"?"Public":"Private"}</small></div></div><div class="social-card-actions"><button type="button" class="btn btn-soft btn-sm" data-channel-open="${escapeHtml(c.id)}">Open</button>${admin?"":(followed?`<button type="button" class="btn btn-soft btn-sm" data-channel-unfollow="${escapeHtml(c.id)}">Unfollow</button>`:`<button type="button" class="btn btn-primary btn-sm" data-channel-follow="${escapeHtml(c.id)}">Follow</button>`)}</div></div>`;
      }).join("");
      bindChannelListInteractions(box);
    });
  }
  async function followChannel(id,follow){const u=user();if(!u)return;try{await updateDoc(doc(db,"channels",id),{subscriberIds:follow?arrayUnion(u.uid):arrayRemove(u.uid),updatedAt:serverTimestamp()});await fetchChannels();showToast(follow?"Channel followed":"Channel unfollowed","success");}catch(e){showToast("Could not update channel follow state.","error");}}
  async function createChannel(){
    const u=user();if(!u)return;const name=$("channelNameInput")?.value.trim();const description=$("channelDescriptionInput")?.value.trim()||"";const privacy=$("channelPrivacy")?.value||"public";const communityId=activeCommunity?.id||null;if(name.length<2){showToast("Channel name is too short.","error");return;}const btn=$("createChannelBtn");if(btn)btn.disabled=true;try{const ref=await addDoc(collection(db,"channels"),{name:name.slice(0,80),nameLower:name.toLowerCase().slice(0,80),description:description.slice(0,500),privacy,ownerId:u.uid,adminIds:[u.uid],subscriberIds:[u.uid],communityId,maxAdmins:10,maxFollowers:0,settings:{comments:"followers",reactions:true},createdAt:serverTimestamp(),updatedAt:serverTimestamp()});if(communityId)await updateDoc(doc(db,"communities",communityId),{channelIds:arrayUnion(ref.id),updatedAt:serverTimestamp()});closeModal("channelComposerModal");await fetchChannels();await openChannel(ref.id);showToast("Channel created","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked channel creation. Deploy the latest rules.":"Could not create channel.","error");}finally{if(btn)btn.disabled=false;}}

  function renderChannelPost(post){
    const media=post.mediaURL?((post.mediaType==="video")?`<video src="${escapeHtml(post.mediaURL)}" controls playsinline preload="metadata"></video>`:`<img src="${escapeHtml(post.mediaURL)}" alt="Channel post">`):"";
    const poll=post.type==="poll"?`<div class="channel-poll"><strong>${escapeHtml(post.pollQuestion||"Poll")}</strong>${(post.pollOptions||[]).map((o,i)=>`<button type="button" data-channel-vote="${i}">${escapeHtml(o)} <small>${Number(post.pollCounts?.[i]||0)}</small></button>`).join("")}</div>`:"";
    return `<article class="channel-post" data-post-id="${escapeHtml(post.id)}"><div class="channel-post-head"><strong>${escapeHtml(post.authorName||"CUNNACT")}</strong><time>${safeTime(post.createdAt)?escapeHtml(formatTime(safeTime(post.createdAt))):""}</time></div><p>${escapeHtml(post.text||"")}</p>${media}${poll}<div class="channel-post-actions"><button type="button" data-post-react="❤️">❤️ ${Number(post.reactionCount||0)}</button><button type="button" data-post-comments>💬 Comments</button></div><div class="channel-comments" hidden></div></article>`;
  }
  async function openChannel(id){
    try{
      const snap=await getDoc(doc(db,"channels",id));
      if(!snap.exists()){showToast("Channel not found.","error");return;}
      activeChannel={id,...snap.data()};
      closeModal("socialHubModal");closeModal("channelDetailModal");closeModal("communityDetailModal");
      const app=document.getElementById("app"),base=$("sidebarDefaultView"),newChat=$("newChatView"),status=$("statusView"),channelsView=$("channelsView"),chat=document.querySelector(".chat-panel"),statusPanel=$("statusPanel"),channelsPanel=$("channelsPanel");
      base?.setAttribute("hidden","");newChat?.setAttribute("hidden","");status?.setAttribute("hidden","");channelsView?.removeAttribute("hidden");chat?.setAttribute("hidden","");statusPanel?.setAttribute("hidden","");if(channelsPanel){channelsPanel.hidden=window.innerWidth<=820;}
      app?.classList.add("channels-open");app?.classList.remove("chat-open","status-open");
      document.querySelectorAll(".nav-rail-btn").forEach(b=>b.classList.remove("active"));document.getElementById("navRequestsBtn")?.classList.add("active");
      $("channelsMainTitle").textContent=activeChannel.name||"Channel";
      $("channelsMainMeta").textContent=`${Number((activeChannel.subscriberIds||[]).length)} followers`;
      const avatar=$("channelsMainAvatar");if(avatar)avatar.innerHTML=channelAvatarHtml(activeChannel);
      renderChannelList($("channelsViewSearch")?.value||"");
      await renderChannelPosts();
    }catch(e){console.error(e);showToast("Could not open channel.","error");}
  }
  async function renderChannelPosts(){
    if(!activeChannel)return;
    const box=$("channelsMainPosts");if(!box)return;
    box.innerHTML='<div class="channels-main-empty"><div class="channels-main-spinner">Loading…</div></div>';
    try{
      const snap=await getDocs(query(collection(db,"channels",activeChannel.id,"posts"),orderBy("createdAt","desc"),limit(50)));
      const posts=snap.docs.map(d=>({id:d.id,...d.data()}));
      const follow=(activeChannel.subscriberIds||[]).includes(user()?.uid),admin=canPostChannel();
      const intro=`<div class="channel-feed-intro"><span>🔔</span><div><strong>You're viewing ${escapeHtml(activeChannel.name||"this channel")}</strong><small>${Number((activeChannel.subscriberIds||[]).length)} followers${activeChannel.description?` · ${escapeHtml(activeChannel.description)}`:""}</small></div>${follow?`<span class="channel-followed-pill">Following</span>`:`<button type="button" class="btn btn-primary btn-sm" id="channelFeedFollowBtn">Follow</button>`}</div>`;
      const adminBox=admin?`<div id="channelInlineComposer" class="channel-inline-composer"><textarea id="channelInlinePostText" maxlength="5000" rows="3" placeholder="Write an update for your followers…"></textarea><div><input id="channelInlinePostMedia" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"><button type="button" class="btn btn-primary btn-sm" id="channelInlinePostSend">Publish</button></div></div>`:"";
      box.innerHTML=`${intro}${adminBox}<div class="channel-post-feed">${posts.length?posts.map(renderChannelPost).join(""):'<div class="channels-list-empty"><strong>No posts yet.</strong><span>New updates from this channel will appear here.</span></div>'}</div>`;
      box.querySelector("#channelFeedFollowBtn")?.addEventListener("click",()=>followChannel(activeChannel.id,true));
      box.querySelector("#channelInlinePostSend")?.addEventListener("click",createInlineChannelPost);
      box.querySelectorAll("[data-post-react]").forEach(b=>b.addEventListener("click",()=>reactToPost(b.closest(".channel-post").dataset.postId,b.dataset.postReact)));
      box.querySelectorAll("[data-post-comments]").forEach(b=>b.addEventListener("click",()=>togglePostComments(b.closest(".channel-post"))));
      box.querySelectorAll("[data-channel-vote]").forEach(b=>b.addEventListener("click",()=>voteChannelPost(b.closest(".channel-post").dataset.postId,Number(b.dataset.channelVote))));
    }catch(e){console.error(e);box.innerHTML='<div class="channels-main-empty"><strong>Posts could not be loaded.</strong><span>Check your connection and try again.</span></div>';}
  }
  async function createInlineChannelPost(){
    if(!activeChannel||!canPostChannel())return;const u=user();const text=$("channelInlinePostText")?.value.trim()||"";const file=$("channelInlinePostMedia")?.files?.[0]||null;if(!text&&!file){showToast("Add text or media.","error");return;}try{let mediaURL="",mediaType="";if(file){const kind=await validateMediaFile(file);mediaURL=await uploadFileToCloudinary(file,{});mediaType=kind;}await addDoc(collection(db,"channels",activeChannel.id,"posts"),{authorId:u.uid,authorName:u.displayName||"CUNNACT",type:"post",text:text.slice(0,5000),mediaURL,mediaType,pollQuestion:"",pollOptions:[],pollCounts:{},pollVotes:{},reactionCount:0,createdAt:serverTimestamp()});$("channelInlinePostText").value="";if($("channelInlinePostMedia"))$("channelInlinePostMedia").value="";await renderChannelPosts();showToast("Channel post published","success");}catch(e){console.error(e);showToast(e?.userMessage||"Could not publish the post.","error");}
  }

  function isChannelOwner(){const u=user();return !!(activeChannel&&u&&activeChannel.ownerId===u.uid);}
  function channelSettings(){return {comments:activeChannel?.settings?.comments||"followers",reactions:activeChannel?.settings?.reactions!==false};}
  async function openChannelManage(){
    if(!isChannelOwner()){showToast("Only the channel owner can change channel controls.","error");return;}
    const m=$("channelManageModal");if(!m)return;
    $("channelManageName") && ($("channelManageName").value=activeChannel.name||"");
    $("channelManageDescription") && ($("channelManageDescription").value=activeChannel.description||"");
    $("channelManagePrivacy") && ($("channelManagePrivacy").value=activeChannel.privacy||"public");
    $("channelMaxAdmins") && ($("channelMaxAdmins").value=Number(activeChannel.maxAdmins||10));
    $("channelMaxFollowers") && ($("channelMaxFollowers").value=Number(activeChannel.maxFollowers||0));
    $("channelCommentsPolicy") && ($("channelCommentsPolicy").value=channelSettings().comments);
    $("channelReactionsEnabled") && ($("channelReactionsEnabled").checked=channelSettings().reactions);
    const people=$("channelManagePeople");if(people)people.innerHTML='<div class="empty-state">Loading connected people…</div>';
    m.hidden=false;m.setAttribute("aria-hidden","false");document.body.classList.add("modal-open");
    const contacts=await getConnectedUsers();
    if(people)people.innerHTML=contacts.length?contacts.map(c=>{
      const isOwner=c.uid===activeChannel.ownerId;const admin=(activeChannel.adminIds||[]).includes(c.uid);const follower=(activeChannel.subscriberIds||[]).includes(c.uid);
      return `<div class="channel-manage-person" data-person-uid="${escapeHtml(c.uid)}"><span class="avatar sm">${c.photoURL?`<img src="${escapeHtml(c.photoURL)}" alt="">`:`<span class="avatar-fallback">${escapeHtml((c.name||c.email||"U").slice(0,2).toUpperCase())}</span>`}</span><span class="channel-manage-person-meta"><strong>${escapeHtml(c.name||c.username||c.email||"Contact")}</strong><small>${isOwner?"Owner":admin?"Admin":follower?"Follower":"Not added"}</small></span><span class="channel-manage-actions">${!follower&&!isOwner?`<button type="button" class="btn btn-soft btn-sm" data-channel-add-follower="${escapeHtml(c.uid)}">Add</button>`:""}${follower&&!isOwner?`<button type="button" class="btn btn-soft btn-sm" data-channel-remove-follower="${escapeHtml(c.uid)}">Remove</button>`:""}${!admin&&!isOwner?`<button type="button" class="btn btn-soft btn-sm" data-channel-add-admin="${escapeHtml(c.uid)}">Make admin</button>`:(admin&&!isOwner?`<button type="button" class="btn btn-soft btn-sm" data-channel-remove-admin="${escapeHtml(c.uid)}">Remove admin</button>`:"")}</span></div>`;
    }).join(""):'<div class="empty-state">Start a 1:1 chat with someone to add them here.</div>';
    people?.querySelectorAll("[data-channel-add-follower]").forEach(b=>b.addEventListener("click",()=>updateChannelPerson(b.dataset.channelAddFollower,"addFollower")));
    people?.querySelectorAll("[data-channel-remove-follower]").forEach(b=>b.addEventListener("click",()=>updateChannelPerson(b.dataset.channelRemoveFollower,"removeFollower")));
    people?.querySelectorAll("[data-channel-add-admin]").forEach(b=>b.addEventListener("click",()=>updateChannelPerson(b.dataset.channelAddAdmin,"addAdmin")));
    people?.querySelectorAll("[data-channel-remove-admin]").forEach(b=>b.addEventListener("click",()=>updateChannelPerson(b.dataset.channelRemoveAdmin,"removeAdmin")));
  }
  async function updateChannelPerson(uid,action){
    if(!isChannelOwner()||!activeChannel)return;
    try{
      const patch={updatedAt:serverTimestamp()};
      if(action==="addFollower")patch.subscriberIds=arrayUnion(uid);
      if(action==="removeFollower")patch.subscriberIds=arrayRemove(uid);
      if(action==="addAdmin"){const max=Number($("channelMaxAdmins")?.value||activeChannel.maxAdmins||10);if((activeChannel.adminIds||[]).length>=max){showToast(`Admin limit reached (${max}). Increase the limit first.` ,"error");return;}patch.adminIds=arrayUnion(uid);patch.subscriberIds=arrayUnion(uid);}
      if(action==="removeAdmin")patch.adminIds=arrayRemove(uid);
      await updateDoc(doc(db,"channels",activeChannel.id),patch);
      activeChannel={...activeChannel,subscriberIds:action==="addFollower"||action==="addAdmin"?Array.from(new Set([...(activeChannel.subscriberIds||[]),uid])):action==="removeFollower"?[...(activeChannel.subscriberIds||[])].filter(x=>x!==uid):activeChannel.subscriberIds,adminIds:action==="addAdmin"?Array.from(new Set([...(activeChannel.adminIds||[]),uid])):action==="removeAdmin"?[...(activeChannel.adminIds||[])].filter(x=>x!==uid):activeChannel.adminIds};
      $("channelsMainMeta").textContent=`${Number((activeChannel.subscriberIds||[]).length)} followers`;
      await openChannelManage();
      showToast(action.includes("Admin")||action==="addAdmin"?"Channel admin updated":"Channel followers updated","success");
      await fetchChannels();
    }catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked this channel change. Deploy the latest rules.":"Could not update the channel.","error");}
  }
  async function saveChannelControls(){
    if(!isChannelOwner()||!activeChannel)return;
    const name=$("channelManageName")?.value.trim()||"";const description=$("channelManageDescription")?.value.trim()||"";const privacy=$("channelManagePrivacy")?.value||"public";const maxAdmins=Math.min(20,Math.max(1,Number($("channelMaxAdmins")?.value||10)));const maxFollowers=Math.min(100000,Math.max(0,Number($("channelMaxFollowers")?.value||0)));
    if(name.length<2){showToast("Channel name is too short.","error");return;}
    if(maxAdmins<(activeChannel.adminIds||[]).length){showToast(`Admin limit cannot be below the current ${activeChannel.adminIds?.length||0} admins.` ,"error");return;}
    if(maxFollowers>0&&maxFollowers<(activeChannel.subscriberIds||[]).length){showToast(`Follower limit cannot be below the current ${activeChannel.subscriberIds?.length||0} followers.` ,"error");return;}
    const settings={comments:$("channelCommentsPolicy")?.value||"followers",reactions:$("channelReactionsEnabled")?.checked!==false};
    const patch={name:name.slice(0,80),nameLower:name.toLowerCase().slice(0,80),description:description.slice(0,500),privacy,maxAdmins,maxFollowers,settings,updatedAt:serverTimestamp()};
    const btn=$("saveChannelControlsBtn");if(btn)btn.disabled=true;
    try{await updateDoc(doc(db,"channels",activeChannel.id),patch);activeChannel={...activeChannel,...patch,createdAt:activeChannel.createdAt};$("channelsMainTitle").textContent=activeChannel.name;$("channelsMainMeta").textContent=`${Number((activeChannel.subscriberIds||[]).length)} followers`;$("channelManageModal")?.setAttribute("hidden","");$("channelManageModal")?.setAttribute("aria-hidden","true");document.body.classList.remove("modal-open");await fetchChannels();await renderChannelPosts();showToast("Channel controls updated","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked channel controls. Deploy the latest rules.":"Could not save channel controls.","error");}finally{if(btn)btn.disabled=false;}
  }
  function canPostChannel(){const u=user();return !!(activeChannel&&u&&(activeChannel.adminIds||[]).includes(u.uid));}
  async function createChannelPost(){
    if(!activeChannel||!canPostChannel())return;const u=user();const text=$("channelPostText")?.value.trim()||"";const file=$("channelPostMedia")?.files?.[0]||null;const pollQuestion=$("channelPostPollQuestion")?.value.trim()||"";const pollOptions=($("channelPostPollOptions")?.value||"").split("\n").map(x=>x.trim()).filter(Boolean).slice(0,6);if(!text&&!file&&!pollQuestion){showToast("Add text, media or a poll.","error");return;}if(pollQuestion&&pollOptions.length<2){showToast("Poll needs at least 2 options.","error");return;}try{let mediaURL="",mediaType="";if(file){const kind=await validateMediaFile(file);mediaURL=await uploadFileToCloudinary(file,{});mediaType=kind;}const ref=await addDoc(collection(db,"channels",activeChannel.id,"posts"),{authorId:u.uid,authorName:u.displayName||"CUNNACT",type:pollQuestion?"poll":"post",text:text.slice(0,5000),mediaURL,mediaType,pollQuestion:pollQuestion.slice(0,250),pollOptions,pollCounts:{},pollVotes:{},reactionCount:0,createdAt:serverTimestamp()});$("channelPostText").value="";$("channelPostPollQuestion").value="";$("channelPostPollOptions").value="";if($("channelPostMedia"))$("channelPostMedia").value="";await renderChannelPosts();showToast("Channel post published","success");}catch(e){console.error(e);showToast(e?.userMessage||"Could not publish the post.","error");}}
  async function reactToPost(postId,emoji){const u=user();if(!activeChannel||!u)return;try{const reactionRef=doc(db,"channels",activeChannel.id,"posts",postId,"reactions",u.uid);const reactionSnap=await getDoc(reactionRef);await setDoc(reactionRef,{uid:u.uid,emoji,createdAt:serverTimestamp()},{merge:true});if(!reactionSnap.exists()){const postRef=doc(db,"channels",activeChannel.id,"posts",postId);const postSnap=await getDoc(postRef);const data=postSnap.data()||{};await updateDoc(postRef,{reactionCount:Number(data.reactionCount||0)+1});}renderChannelPosts();}catch(e){showToast("Could not react to post.","error");}}
  async function voteChannelPost(postId,index){const u=user();if(!u||!activeChannel)return;try{const ref=doc(db,"channels",activeChannel.id,"posts",postId),snap=await getDoc(ref),data=snap.data()||{},votes={...(data.pollVotes||{})},counts={...(data.pollCounts||{})};const old=votes[u.uid];if(old!==undefined&&Number(old)===index)return;if(old!==undefined)counts[old]=Math.max(0,Number(counts[old]||0)-1);votes[u.uid]=index;counts[index]=Number(counts[index]||0)+1;await updateDoc(ref,{pollVotes:votes,pollCounts:counts});await renderChannelPosts();showToast("Vote saved","success");}catch(e){showToast("Could not save vote.","error");}}
  async function togglePostComments(postEl){const box=postEl?.querySelector(".channel-comments");if(!box||!activeChannel)return;box.hidden=!box.hidden;if(box.hidden)return;const postId=postEl.dataset.postId;try{const snap=await getDocs(query(collection(db,"channels",activeChannel.id,"posts",postId,"comments"),orderBy("createdAt","asc"),limit(50)));box.innerHTML=`${snap.docs.map(d=>{const x=d.data();return `<div class="channel-comment"><strong>${escapeHtml(x.authorName||"User")}</strong><span>${escapeHtml(x.text||"")}</span></div>`;}).join("")}<div class="channel-comment-form"><input type="text" placeholder="Write a comment…" data-comment-input><button type="button" class="btn btn-primary btn-sm" data-comment-send>Send</button></div>`;box.querySelector("[data-comment-send]")?.addEventListener("click",async()=>{const input=box.querySelector("[data-comment-input]"),text=input?.value.trim();if(!text)return;const u=user();try{await addDoc(collection(db,"channels",activeChannel.id,"posts",postId,"comments"),{authorId:u.uid,authorName:u.displayName||"CUNNACT",text:text.slice(0,1000),createdAt:serverTimestamp()});input.value="";await togglePostComments(postEl);togglePostComments(postEl);}catch(e){showToast("Could not add comment.","error");}});
    }catch{box.innerHTML='<div class="empty-state">Comments could not be loaded.</div>';}}

  function syncStatusMyAvatar(){
    const u=user();
    const src=document.getElementById("currentUserAvatar");
    const dst=document.getElementById("statusMyAvatar");
    if(!dst)return;
    const dstImg=dst.querySelector("img"),dstFallback=dst.querySelector(".avatar-fallback");
    const srcImg=src?.querySelector("img"),srcFallback=src?.querySelector(".avatar-fallback");
    if(dstImg){dstImg.src=srcImg?.src||u?.photoURL||"";dstImg.hidden=!(srcImg&&!srcImg.hidden)||!dstImg.src;}
    if(dstFallback){dstFallback.textContent=srcFallback?.textContent||(u?.displayName||"C").slice(0,2).toUpperCase();dstFallback.hidden=!!(srcImg&&!srcImg.hidden);}
  }
  function renderMyTraceSummary(){
    const u=user();if(!u)return;
    const row=$("myStatusRow"),copy=row?.querySelector(".my-status-copy");if(!copy)return;
    const active=myTraceCache.filter(s=>!isExpired(s));
    const remote=stories.filter(s=>s.ownerId===u.uid&&!isExpired(s));
    const own=active.length?active:remote;
    const latest=own[0];
    const small=copy.querySelector("small");
    if(small)small.textContent=latest?(own.length===1?`Active trace · ${safeTime(latest.createdAt)?formatTime(safeTime(latest.createdAt)):"now"} · Tap to view`:`${own.length} active traces · Tap to view`):"Tap to leave a trace";
  }
  function renderStatusPage(){
    const list=$("statusUpdatesList");
    const main=$("statusPanel");
    if(!list||!main)return;
    syncStatusMyAvatar();
    renderMyTraceSummary();
    const grouped=new Map();
    stories.filter(s=>s.ownerId!==user()?.uid).forEach(story=>{if(!grouped.has(story.ownerId))grouped.set(story.ownerId,[]);grouped.get(story.ownerId).push(story);});
    if(!grouped.size){list.innerHTML='<div class="status-list-empty"><strong>No recent traces</strong><span>New traces from your contacts will appear here.</span></div>';return;}
    list.innerHTML=[...grouped.entries()].map(([ownerId,items])=>{
      const first=items[0],name=first.ownerName||"CUNNACT user",unseen=items.some(x=>!(x.viewers||[]).includes(user()?.uid));
      const avatar=first.ownerPhotoURL?`<img src="${escapeHtml(first.ownerPhotoURL)}" alt="">`:`<span>${escapeHtml(name.slice(0,1).toUpperCase())}</span>`;
      const when=safeTime(first.createdAt);
      const label=when?`Today at ${formatTime(when)}`:"Recent trace";
      return `<button type="button" class="status-update-row ${unseen?"unseen":"seen"}" data-status-owner="${escapeHtml(ownerId)}">
        <span class="status-avatar-ring ${unseen?"unseen":"seen"}"><span class="status-avatar-inner">${avatar}</span></span>
        <span class="status-update-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(label)}</small></span>
      </button>`;
    }).join("");
    list.querySelectorAll("[data-status-owner]").forEach(btn=>btn.addEventListener("click",()=>openStoryViewer(btn.dataset.statusOwner)));
  }
  async function openStatusPage(){
    window.closeCallsPage?.();
    const app=document.getElementById("app"),base=document.getElementById("sidebarDefaultView"),newChat=document.getElementById("newChatView"),view=document.getElementById("statusView"),chat=document.querySelector(".chat-panel"),panel=document.getElementById("statusPanel");
    if(!app||!view||!chat||!panel)return;
    base?.setAttribute("hidden","true");newChat?.setAttribute("hidden","true");view.hidden=false;chat.hidden=true;panel.hidden=false;app.classList.add("status-open");app.classList.remove("chat-open");
    document.querySelectorAll(".nav-rail-btn").forEach(b=>b.classList.remove("active"));document.getElementById("navStoriesBtn")?.classList.add("active");
    try{await fetchStories();renderStatusPage();}catch(e){console.warn("Trace load failed",e);renderStatusPage();}
  }
  function closeStatusPage(){
    const app=document.getElementById("app"),base=document.getElementById("sidebarDefaultView"),view=document.getElementById("statusView"),chat=document.querySelector(".chat-panel"),panel=document.getElementById("statusPanel");
    if(!view)return;view.hidden=true;base?.removeAttribute("hidden");chat?.removeAttribute("hidden");if(panel)panel.hidden=true;app?.classList.remove("status-open");document.querySelectorAll(".nav-rail-btn").forEach(b=>b.classList.remove("active"));document.getElementById("navChatsBtn")?.classList.add("active");
  }
  function openSocialTab(tab){document.querySelectorAll(".social-tab").forEach(b=>b.classList.toggle("active",b.dataset.socialTab===tab));document.querySelectorAll(".social-panel").forEach(p=>p.hidden=p.dataset.socialPanel!==tab);if(tab==="stories")fetchStories().then(renderStoryList);if(tab==="communities")fetchCommunities();if(tab==="channels")fetchChannels();}
  function openSocialHub(tab="stories"){openModal("socialHubModal");openSocialTab(tab);}
  function closeChannelsPage(){
    const app=$("app"),base=$("sidebarDefaultView"),view=$("channelsView"),panel=$("channelsPanel"),chat=document.querySelector(".chat-panel");
    if(!view)return;view.hidden=true;base?.removeAttribute("hidden");panel?.setAttribute("hidden","");chat?.removeAttribute("hidden");app?.classList.remove("channels-open");
  }
  async function openChannelsPage(){
    window.closeCallsPage?.();
    const app=$("app"),base=$("sidebarDefaultView"),newChat=$("newChatView"),status=$("statusView"),view=$("channelsView"),chat=document.querySelector(".chat-panel"),statusPanel=$("statusPanel"),panel=$("channelsPanel");
    if(!app||!view||!panel)return;base?.setAttribute("hidden","");newChat?.setAttribute("hidden","");status?.setAttribute("hidden","");view.hidden=false;chat?.setAttribute("hidden","");statusPanel?.setAttribute("hidden","");panel.hidden=false;app.classList.add("channels-open");app.classList.remove("chat-open","status-open");document.querySelectorAll(".nav-rail-btn").forEach(b=>b.classList.remove("active"));document.getElementById("navRequestsBtn")?.classList.add("active");try{await fetchChannels();}catch(e){console.warn("Channels load failed",e);renderChannelList($("channelsViewSearch")?.value||"");}
  }
  function bind(){
    if(socialBound)return;socialBound=true;
    $("navStoriesBtn")?.addEventListener("click",()=>{closeChannelsPage();openStatusPage();});
    $("navChatsBtn")?.addEventListener("click",()=>{window.closeCallsPage?.();closeStatusPage();closeChannelsPage();});$("navNewChatBtn")?.addEventListener("click",()=>{window.closeCallsPage?.();closeStatusPage();closeChannelsPage();});$("newChatBtn")?.addEventListener("click",()=>{window.closeCallsPage?.();closeStatusPage();closeChannelsPage();});
    $("channelsCreateBtn")?.addEventListener("click",()=>openModal("channelComposerModal"));
    $("channelsViewSearch")?.addEventListener("input",e=>renderChannelList(e.target.value));
    $("channelsMobileBackBtn")?.addEventListener("click",()=>{
      if(window.innerWidth<=820){
        const app=$("app"),view=$("channelsView"),panel=$("channelsPanel"),chat=document.querySelector(".chat-panel");
        activeChannel=null;view?.removeAttribute("hidden");panel?.setAttribute("hidden","");chat?.setAttribute("hidden","");app?.classList.remove("channels-open","chat-open","status-open");
      } else { closeChannelsPage(); }
    });
    $("channelsMainMoreBtn")?.addEventListener("click",e=>{e.stopPropagation();const m=$("channelsMainMoreMenu");if(!m)return;const followed=(activeChannel?.subscriberIds||[]).includes(user()?.uid);const owner=isChannelOwner();m.innerHTML=`${owner?`<button type="button" class="dropdown-item" data-channel-action="manage"><span>Channel controls</span></button>`:""}<button type="button" class="dropdown-item" data-channel-action="info"><span>Channel info</span></button>${followed&&!owner?`<button type="button" class="dropdown-item" data-channel-action="unfollow"><span>Unfollow channel</span></button>`:!owner?`<button type="button" class="dropdown-item" data-channel-action="follow"><span>Follow channel</span></button>`:""}`;m.hidden=!m.hidden;m.querySelector('[data-channel-action="follow"]')?.addEventListener("click",()=>followChannel(activeChannel.id,true));m.querySelector('[data-channel-action="unfollow"]')?.addEventListener("click",()=>followChannel(activeChannel.id,false));m.querySelector('[data-channel-action="info"]')?.addEventListener("click",()=>showToast(activeChannel?.description||"No channel description.","info"));m.querySelector('[data-channel-action="manage"]')?.addEventListener("click",openChannelManage);});
    document.addEventListener("click",e=>{if(!e.target.closest(".channels-main-actions"))$("channelsMainMoreMenu")?.setAttribute("hidden","");});
    $("statusAddBtn")?.addEventListener("click",e=>{e.stopPropagation();$("statusMoreMenu")?.setAttribute("hidden","");const m=$("statusAddMenu");if(m)m.hidden=!m.hidden;});
    $("myStatusRow")?.addEventListener("click",()=>openTraceComposer("text"));
    $("statusMoreBtn")?.addEventListener("click",e=>{e.stopPropagation();$("statusAddMenu")?.setAttribute("hidden","");const m=$("statusMoreMenu");if(m)m.hidden=!m.hidden;});
    document.querySelectorAll("[data-status-create]").forEach(b=>b.addEventListener("click",()=>{const mode=b.dataset.statusCreate;$("statusAddMenu")?.setAttribute("hidden","");openTraceComposer(mode); }));
    document.querySelectorAll("[data-status-action]").forEach(b=>b.addEventListener("click",async()=>{const action=b.dataset.statusAction;$("statusMoreMenu")?.setAttribute("hidden","");if(action==="refresh"){await fetchStories();renderStatusPage();showToast("Traces refreshed","success");}else if(action==="privacy"){openTracePrivacy();}}));
    document.addEventListener("click",e=>{if(!e.target.closest(".status-side-actions")){$("statusAddMenu")?.setAttribute("hidden","");$("statusMoreMenu")?.setAttribute("hidden","");}});
    $("storiesViewAllBtn")?.addEventListener("click",()=>openSocialHub("stories"));
    $("storiesAddBtn")?.addEventListener("click",()=>openTraceComposer("text"));
    $("createStoryBtn")?.addEventListener("click",()=>openTraceComposer("text"));$("publishStoryBtn")?.addEventListener("click",createStory);$("storyPrivacy")?.addEventListener("change",renderStoryAudiencePicker);$("storyViewerCloseBtn")?.addEventListener("click",()=>closeModal("storyViewerModal"));$("traceViewerBackBtn")?.addEventListener("click",()=>{closeModal("storyViewerModal");openStatusPage();});$("traceViewerStickerBtn")?.addEventListener("click",()=>showToast("Use the emoji/sticker tools in the trace composer.","info"));$("storyPrevBtn")?.addEventListener("click",()=>{if(storyCursor>0){storyCursor--;markStoryViewed(storyCandidates[storyCursor]);renderStoryViewer();}});$("storyNextBtn")?.addEventListener("click",()=>{if(storyCursor<storyCandidates.length-1){storyCursor++;markStoryViewed(storyCandidates[storyCursor]);renderStoryViewer();}});$("storyReplySendBtn")?.addEventListener("click",storyReply);$("storyReactBtn")?.addEventListener("click",()=>storyReact($("storyReactionEmoji")?.value||"❤️"));
    $("storyMediaInput")?.addEventListener("change",syncTraceMediaPreview);
    $("traceMediaBtn")?.addEventListener("click",()=>$("storyMediaInput")?.click());
    $("traceEmojiBtn")?.addEventListener("click",e=>{e.stopPropagation();const p=$("traceEmojiPanel");if(p)p.hidden=!p.hidden;});
    document.querySelectorAll("[data-trace-emoji]").forEach(b=>b.addEventListener("click",()=>{appendTraceEmoji(b.dataset.traceEmoji);$("traceEmojiPanel")?.setAttribute("hidden","");}));
    $("tracePaletteBtn")?.addEventListener("click",()=>{traceBackgroundIndex=(traceBackgroundIndex+1)%traceBackgrounds.length;syncTraceComposer();});
    $("traceTextStyleBtn")?.addEventListener("click",()=>{const input=$("storyTextInput");if(!input)return;const style=input.dataset.traceStyle||"normal";input.dataset.traceStyle=style==="normal"?"large":style==="large"?"script":"normal";syncTraceComposer();});
    $("traceAudienceBtn")?.addEventListener("click",openTracePrivacy);
    $("traceMoreBtn")?.addEventListener("click",e=>{e.stopPropagation();const p=$("traceToolsPanel");if(p)p.hidden=!p.hidden;});
    $("tracePrivacyDoneBtn")?.addEventListener("click",closeTracePrivacy);
    setupTracePrivacyInputs();
    document.addEventListener("click",e=>{if(!e.target.closest(".trace-composer-tools")&&!e.target.closest("#traceEmojiPanel"))$("traceEmojiPanel")?.setAttribute("hidden","");});
    $("createCommunityBtn")?.addEventListener("click",createCommunity);$("createCommunityOpenBtn")?.addEventListener("click",()=>openModal("communityComposerModal"));$("communitySearchInput")?.addEventListener("input",e=>renderCommunityList(e.target.value));$("communitySubgroupBtn")?.addEventListener("click",()=>{openModal("subgroupComposerModal");renderSubgroupPicker();});$("communityJoinRequestsBtn")?.addEventListener("click",openCommunityJoinRequests);$("createSubgroupBtn")?.addEventListener("click",createCommunityGroup);$("communityChannelBtn")?.addEventListener("click",()=>{openModal("channelComposerModal");$("channelCommunityLabel").textContent=activeCommunity?`Inside ${activeCommunity.name}`:"Standalone channel";});
    $("createChannelBtn")?.addEventListener("click",createChannel);$("createChannelBtnTop")?.addEventListener("click",()=>{openModal("channelComposerModal");$("channelCommunityLabel").textContent="Standalone channel";});$("channelSearchInput")?.addEventListener("input",e=>renderChannelList(e.target.value));$("channelPostSendBtn")?.addEventListener("click",createChannelPost);$("saveChannelControlsBtn")?.addEventListener("click",saveChannelControls);$("channelManageOpenBtn")?.addEventListener("click",openChannelManage);
    document.querySelectorAll(".social-tab").forEach(b=>b.addEventListener("click",()=>openSocialTab(b.dataset.socialTab)));
    document.querySelectorAll("[data-social-open]").forEach(b=>b.addEventListener("click",()=>openSocialHub(b.dataset.socialOpen)));
  }
  const loadTraceAudienceDefault = async () => {
    const u=user();
    if(!u)return;
    try{
      const snap=await getDoc(doc(db,"userSettings",u.uid));
      const value=snap.exists()?snap.data()?.traceAudienceDefault:"public";
      if(["public","closeFriends","custom"].includes(value))traceAudienceDefault=value;
    }catch(e){console.warn("Could not load trace privacy default",e);}
  };
  bind();
  loadTraceAudienceDefault().catch(()=>{});
  return { refresh:()=>{fetchStories().then(renderStoryList);fetchCommunities();fetchChannels();}, openStatusPage, closeStatusPage, openChannelsPage, closeChannelsPage, openCommunity, openChannel, openChannelManage, destroy:()=>{storyUnsub?.();communityUnsub?.();channelUnsub?.();} };
}
