import { db, doc, getDoc, setDoc, serverTimestamp, functions, httpsCallable } from "./firebase.js";
import { uploadFileToCloudinary, mediaKind, validateMediaFile, UploadError } from "./cloudinary.js";
import { escapeHtml } from "./ui.js";
import { showToast } from "./toast.js";

const MAX_CONTEXT_MESSAGES = 180;
const aiCallable = httpsCallable(functions, "cunnactAI");

function safe(v, max = 5000) { return String(v ?? "").trim().slice(0, max); }
function currentTimestamp(v) { return v?.toDate?.() || (v instanceof Date ? v : null); }
function buildContext(messages, currentUid, activeUser) {
  return (messages || []).slice(-MAX_CONTEXT_MESSAGES).map(m => {
    const name = m.senderId === currentUid ? "You" : (activeUser?.isGroup ? (m.senderName || "Member") : (activeUser?.name || "Contact"));
    const text = m.deletedAt ? "[Deleted message]" : (m.type === "text" ? safe(m.text, 1200) :
      ({ image:"[Photo]", video:"[Video]", audio:"[Voice message]", document:`[Document: ${safe(m.fileName, 100)}]`, gif:"[GIF]", sticker:"[Sticker]", contact:`[Contact: ${safe(m.contactName,100)}]`, location:"[Location]", poll:`[Poll: ${safe(m.pollQuestion || m.text,150)}]`, event:`[Event: ${safe(m.eventTitle || m.text,150)}]` }[m.type] || "[Attachment]"));
    const when = currentTimestamp(m.createdAt);
    return { ...m, senderName:name, text:text.slice(0,1200), createdAtMs:when?.getTime() || 0 };
  });
}

export function initAIFeatures({ getCurrentUser, getCurrentUserSettings, getCurrentMessages, getActiveUser, setComposerText, useGeneratedPoll } = {}) {
  let bound = false;
  let mediaUrl = "";
  let mediaKindValue = "";
  let recorder = null;
  let voiceChunks = [];

  const $ = id => document.getElementById(id);
  const modal = $("aiModal");
  const result = $("aiResult");
  const status = $("aiStatus");
  const consent = $("aiConsent");
  const action = $("aiAction");
  const prompt = $("aiPrompt");

  function setStatus(message = "") { if (status) status.textContent = message; }
  function setResult(text = "") { if (result) { result.hidden = !text; result.textContent = text; } }
  function open(tabAction = "assistant") {
    if (!modal) return;
    const settings = getCurrentUserSettings?.() || {};
    consent.checked = settings.aiEnabled === true;
    action.value = tabAction;
    setResult(""); setStatus("");
    $("aiOutputActions")?.classList.add("hidden");
    $("aiUsePollBtn")?.setAttribute("hidden","");
    $("aiQuickReplies")?.setAttribute("hidden","");
    modal.hidden = false; modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open");
    setTimeout(() => $("aiPrompt")?.focus(), 20);
  }
  function close() {
    if (!modal) return; modal.hidden = true; modal.setAttribute("aria-hidden","true");
    if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
  }
  async function saveConsent() {
    const u = getCurrentUser?.(); if (!u) return false;
    try {
      await setDoc(doc(db,"userSettings",u.uid),{ aiEnabled:!!consent.checked, updatedAt:serverTimestamp() },{merge:true});
      showToast(consent.checked ? "CUNNACT AI enabled" : "CUNNACT AI disabled","success");
      return true;
    } catch (e) { console.error(e); showToast("Could not save AI privacy setting.","error"); return false; }
  }
  function requireConsent() {
    if (consent?.checked) return true;
    showToast("Enable AI content processing first. Your chat is only sent when you request an AI action.","info");
    return false;
  }
  function contextPayload() {
    const u=getCurrentUser?.(), messages=buildContext(getCurrentMessages?.()||[],u?.uid,getActiveUser?.());
    return messages;
  }
  function showOutput(text) {
    const str=safe(text,12000); setResult(str);
    $("aiOutputActions")?.classList.toggle("hidden",!str);
    return str;
  }
  async function runAI() {
    if (!requireConsent()) return;
    const act=action?.value||"assistant";
    const p=safe(prompt?.value||"",12000);
    const u=getCurrentUser?.(); if(!u)return;
    setStatus("CUNNACT AI is thinking…"); setResult(""); $("aiRunBtn").disabled=true;
    try {
      const payload={action:act,consent:true,text:p,messages:contextPayload(),language:$('aiLanguage')?.value||"English",tone:$('aiTone')?.value||"natural"};
      if ((act === "file-summary" || act === "image-understanding") && !mediaUrl) throw new Error("UPLOAD_MEDIA_FIRST");
      if (mediaUrl) payload.url=mediaUrl;
      const response=await aiCallable(payload); const data=response.data||{};
      if (act === "smart-replies") {
        const replies=Array.isArray(data.replies)?data.replies:[];
        showOutput(replies.map((x,i)=>`${i+1}. ${x}`).join("\n"));
        const box=$("aiQuickReplies"); if(box){box.innerHTML=replies.map(x=>`<button type="button" class="ai-quick-reply" data-reply="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join("");box.hidden=!replies.length;box.querySelectorAll(".ai-quick-reply").forEach(b=>b.addEventListener("click",()=>setComposerText?.(b.dataset.reply)));}
      } else if (act === "poll") {
        const poll=data.poll||{}; const text=`${poll.question||"Poll"}\n${(poll.options||[]).map((x,i)=>`${i+1}. ${x}`).join("\n")}`; showOutput(text);
        const pollBtn=$("aiUsePollBtn"); if(pollBtn){pollBtn.hidden=!getActiveUser?.()?.isGroup; window.__cunnactGeneratedPoll=poll; pollBtn.onclick=()=>{useGeneratedPoll?.(poll);close();};}
      } else {
        showOutput(data.text||"");
      }
      setStatus("Done");
    } catch (e) {
      console.error("CUNNACT AI",e);
      const code=e?.code||"";
      const message=code.includes("resource-exhausted")?"Daily AI limit reached. Try again tomorrow.":code.includes("failed-precondition")?"AI is not configured on the server yet. Deploy the AI Cloud Function and add its secret.":e?.message==="UPLOAD_MEDIA_FIRST"?"Upload a file/image first.":"CUNNACT AI could not complete that request.";
      setStatus(message); showToast(message,"error");
    } finally { $("aiRunBtn").disabled=false; }
  }
  async function handleMedia(file) {
    if (!requireConsent() || !file) return;
    setStatus("Uploading securely to CUNNACT media storage…");
    try {
      const kind=mediaKind(file);
      await validateMediaFile(file);
      if (!['image','document'].includes(kind)) throw new UploadError("type","AI analysis currently supports images and documents.");
      mediaUrl=await uploadFileToCloudinary(file,{}); mediaKindValue=kind;
      setStatus(`${kind==='image'?'Image':'Document'} ready for AI analysis.`);
      if($("aiMediaName"))$("aiMediaName").textContent=file.name;
      action.value=kind==='image'?"image-understanding":"file-summary";
    } catch(e) { console.error(e); mediaUrl=""; mediaKindValue=""; setStatus(e?.userMessage||"Could not prepare this file for AI."); showToast(e?.userMessage||"Could not upload the file.","error"); }
  }
  async function transcribeBlob(blob) {
    if (!requireConsent()) return;
    if (!blob || blob.size > 9*1024*1024) { showToast("Voice recording must be 9 MB or smaller.","error"); return; }
    setStatus("Transcribing voice…");
    try {
      const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result||"").split(",")[1]||"");r.onerror=reject;r.readAsDataURL(blob);});
      const response=await aiCallable({action:"transcribe",consent:true,audioBase64:base64,mimeType:blob.type||"audio/webm"});
      const text=response.data?.text||""; prompt.value=text; setStatus(text?"Transcript ready — edit it before using it.":"No speech detected.");
    } catch(e) { console.error(e); setStatus("Voice transcription failed."); showToast("Voice transcription failed.","error"); }
  }
  async function recordVoice() {
    if(recorder){recorder.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){showToast("Voice recording is not supported here.","error");return;}
    if(!requireConsent())return;
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(x=>MediaRecorder.isTypeSupported?.(x))||"";
      voiceChunks=[];recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
      recorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data);};
      recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(voiceChunks,{type:recorder?.mimeType||"audio/webm"});recorder=null;voiceChunks=[];$("aiVoiceBtn").textContent="🎤 Voice to text";transcribeBlob(blob);};
      recorder.start();$("aiVoiceBtn").textContent="⏹ Stop & transcribe";setStatus("Recording…");
    } catch(e){console.error(e);recorder=null;showToast("Microphone permission was denied.","error");}
  }
  function bind(){
    if(bound)return;bound=true;
    $("navAIBtn")?.addEventListener("click",()=>open("assistant"));
    $("aiCloseBtn")?.addEventListener("click",close);
    consent?.addEventListener("change",saveConsent);
    $("aiRunBtn")?.addEventListener("click",runAI);
    $("aiFileInput")?.addEventListener("change",e=>handleMedia(e.target.files?.[0]));
    $("aiVoiceBtn")?.addEventListener("click",recordVoice);
    $("aiInsertBtn")?.addEventListener("click",()=>{const value=result?.textContent||"";if(value)setComposerText?.(value.replace(/^\d+\.\s/gm,""));close();});
    $("aiClearMediaBtn")?.addEventListener("click",()=>{mediaUrl="";mediaKindValue="";if($("aiFileInput"))$("aiFileInput").value="";if($("aiMediaName"))$("aiMediaName").textContent="No file selected";setStatus("");});
    action?.addEventListener("change",()=>{
      const a=action.value;
      $("aiLanguageWrap")?.toggleAttribute("hidden",a!=="translate");
      $("aiToneWrap")?.toggleAttribute("hidden",a!=="rewrite");
      $("aiMediaWrap")?.toggleAttribute("hidden",!['file-summary','image-understanding','transcribe'].includes(a));
      $("aiPrompt")?.setAttribute("placeholder",a==='assistant'?"Ask CUNNACT AI anything…":a==='summary'?"Optional focus, e.g. decisions and action items…":a==='poll'?"What should the poll be about?":"Enter text for this action…");
    });
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&modal&&!modal.hidden)close();});
  }
  bind();
  return {open,close,runAI};
}
