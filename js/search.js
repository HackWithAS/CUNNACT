import { db, doc, getDoc, getDocs, collection, query, where, orderBy, startAt, endAt, limit } from "./firebase.js";
import { escapeHtml } from "./ui.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { showToast } from "./toast.js";

const safe = v => String(v ?? "").trim().toLowerCase();
function messageText(m){
  if(m.type==="image")return "📷 Photo"; if(m.type==="video")return "🎬 Video"; if(m.type==="audio")return "🎤 Voice message"; if(m.type==="document")return `📄 ${m.fileName||"Document"}`; if(m.type==="location")return "📍 Location"; if(m.type==="contact")return `👤 ${m.contactName||"Contact"}`; if(m.type==="poll")return `📊 ${m.text||m.pollQuestion||"Poll"}`; if(m.type==="event")return `📅 ${m.text||m.eventTitle||"Event"}`; if(m.type==="gif")return "GIF"; return String(m.text||"");
}
export function initGlobalSearch({getCurrentUser,getConversations,getUserById,onOpenChat,onOpenProfile,onOpenSocial}){
  const $=id=>document.getElementById(id);
  let bound=false,token=0;
  const modal=$("globalSearchModal"), input=$("globalSearchInput"), box=$("globalSearchResults");
  const open=()=>{ if(!modal)return; modal.hidden=false; modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open"); setTimeout(()=>input?.focus(),20); };
  const close=()=>{if(!modal)return;modal.hidden=true;modal.setAttribute("aria-hidden","true");if(!document.querySelector(".modal:not([hidden])"))document.body.classList.remove("modal-open");};
  const renderEmpty=(msg)=>{if(box)box.innerHTML=`<div class="empty-state">${escapeHtml(msg)}</div>`;};
  async function search(term){
    const t=++token,raw=String(term||"").trim(),q=safe(raw).replace(/^@/,"");
    if(!box)return;
    if(!q){renderEmpty("Search people, chats, messages, groups, communities or channels.");return;}
    box.innerHTML='<div class="empty-state">Searching CUNNACT…</div>';
    const user=getCurrentUser?.(); if(!user)return;
    const conversations=getConversations?.()||[];
    const sections=[];
    const connected=[];
    for(const c of conversations){
      const isGroup=c.type==="group";
      if(isGroup){ if(safe(c.groupName).includes(q)) connected.push({kind:"group",id:c.id,title:c.groupName||"Group",subtitle:"Group chat",conversation:c}); }
      else { const other=(c.members||[]).find(x=>x!==user.uid); const u=getUserById?.(other); if(u && (safe(u.name).includes(q)||safe(u.username).includes(q)||safe(u.email).includes(q))) connected.push({kind:"chat",id:c.id,title:u.name||u.username||"Contact",subtitle:u.username?`@${u.username}`:"Connected contact",conversation:c,user:u}); }
    }
    if(connected.length)sections.push({title:"Your chats",items:connected.slice(0,20)});
    // Search recently cached message data, capped to avoid an unbounded read storm.
    const messages=[];
    for(const c of conversations.slice(0,20)){
      try{
        const snap=await getDocs(query(collection(db,"conversations",c.id,"messages"),orderBy("createdAt","desc"),limit(40)));
        snap.docs.forEach(d=>{const m={id:d.id,...d.data()};const text=safe(messageText(m));if(text.includes(q)&&!m.deletedAt)messages.push({kind:"message",id:m.id,conversation:c,message:m,text:messageText(m)});});
      }catch{}
    }
    if(t!==token)return;
    if(messages.length)sections.push({title:"Messages",items:messages.slice(0,30)});
    // Discover public profiles. Rules require a query constrained to public/searchable docs.
    try{
      const qs=[];
      if(raw.startsWith("@") || /^[a-z0-9_]+$/i.test(raw)) qs.push(getDocs(query(collection(db,"publicProfiles"),where("profileVisibility","==","public"),where("discoverable","==",true),orderBy("usernameLower"),startAt(q),endAt(`${q}\uf8ff`),limit(20))));
      qs.push(getDocs(query(collection(db,"publicProfiles"),where("profileVisibility","==","public"),where("discoverable","==",true),orderBy("displayNameLower"),startAt(q),endAt(`${q}\uf8ff`),limit(20))));
      const snaps=await Promise.all(qs);const map=new Map();snaps.flatMap(s=>s.docs).forEach(d=>map.set(d.id,{uid:d.id,...d.data()}));
      const people=[...map.values()].filter(x=>x.uid!==user.uid).slice(0,25);
      if(people.length)sections.push({title:"People",items:people.map(p=>({kind:"person",id:p.uid,title:p.displayName||p.username||"CUNNACT user",subtitle:p.username?`@${p.username}`:"Public profile",user:p}))});
    }catch(e){console.warn("Global people search failed",e);}
    try{
      const [communitySnap,channelSnap]=await Promise.all([
        getDocs(query(collection(db,"communities"),where("privacy","==","public"),limit(30))),
        getDocs(query(collection(db,"channels"),where("privacy","==","public"),limit(30)))
      ]);
      const communities=communitySnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>safe(x.name).includes(q)).slice(0,12);
      const channels=channelSnap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>safe(x.name).includes(q)).slice(0,12);
      if(communities.length)sections.push({title:"Communities",items:communities.map(x=>({kind:"community",id:x.id,title:x.name,subtitle:"Public community",data:x}))});
      if(channels.length)sections.push({title:"Channels",items:channels.map(x=>({kind:"channel",id:x.id,title:x.name,subtitle:"Public channel",data:x}))});
    }catch(e){console.warn("Global discovery failed",e);}
    if(t!==token)return;
    if(!sections.length){renderEmpty("No CUNNACT results found.");return;}
    box.innerHTML=sections.map(s=>`<section class="global-search-section"><div class="global-search-section-title">${escapeHtml(s.title)}</div>${s.items.map(item=>`<button type="button" class="global-result" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}"><span class="global-result-avatar">${item.user?avatarHtml(item.user,{dot:false}):item.kind==="group"?"👥":item.kind==="community"?"◎":item.kind==="channel"?"#":"💬"}</span><span class="meta"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.subtitle||item.text||"")}</small></span></button>`).join("")}</section>`).join("");
    box.querySelectorAll(".global-result").forEach(btn=>btn.addEventListener("click",()=>{
      const item=[...sections.flatMap(s=>s.items)].find(x=>x.kind===btn.dataset.kind&&x.id===btn.dataset.id); if(!item)return;
      if(item.kind==="chat"||item.kind==="group"||item.kind==="message"){close();onOpenChat?.(item.conversation?.id,item.kind==="chat"?item.user?.uid:null,item.kind==="message"?item.message?.id:null);} 
      else if(item.kind==="person"){close();onOpenProfile?.(item.user);}
      else if(item.kind==="community"||item.kind==="channel"){close();onOpenSocial?.(item.kind,item.data);}
    }));
  }
  function bind(){
    if(bound)return;bound=true;
    $("globalSearchBtn")?.addEventListener("click",open);
    $("globalSearchCloseBtn")?.addEventListener("click",close);
    input?.addEventListener("input",()=>search(input.value));
    input?.addEventListener("keydown",e=>{if(e.key==="Escape")close();});
  }
  bind();
  return {open,close,search};
}
