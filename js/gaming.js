import {
  auth, db, onAuthStateChanged, doc, getDoc, getDocs, setDoc, updateDoc,
  collection, query, where, limit, onSnapshot, serverTimestamp
} from "./firebase.js";

const $ = id => document.getElementById(id);
const qsa = sel => [...document.querySelectorAll(sel)];
const esc = value => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));
const rand = n => Math.floor(Math.random() * n);
const ONLINE_GAMES = new Set(["chess","ludo","ttt","c4","checkers","uno"]);
const GAME_NAMES = {chess:"Chess",ludo:"Ludo",ttt:"Tic Tac Toe",c4:"Connect 4",checkers:"Checkers",uno:"UNO-style Cards",pong:"Pong",candy:"Candy Crush"};
let currentUser = null;
let inviteUnsub = null;
let roomUnsub = null;
let activeRoomId = "";
let currentContacts = [];
let pendingInvites = [];

function toast(message, type="info") {
  let box = $("gameToast");
  if (!box) {
    box = document.createElement("div");
    box.id = "gameToast";
    box.className = "game-toast";
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.dataset.type = type;
  box.classList.add("show");
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.remove("show"), 2600);
}

function isMyTurn(room) { return !!currentUser && room?.turnUid === currentUser.uid; }
function roleFor(room) { return room?.hostId === currentUser?.uid ? "host" : room?.guestId === currentUser?.uid ? "guest" : ""; }
function otherUid(room) { return roleFor(room) === "host" ? room.guestId : room.hostId; }
function roomLink(roomId) { return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`; }

function initialState(game) {
  if (game === "ttt") return {board:Array(9).fill(""),turn:1,winner:0,draw:false};
  if (game === "c4") return {board:Array(42).fill(0),turn:1,winner:0,draw:false};
  if (game === "chess") return {fen:"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",winner:0,draw:false,lastMove:null};
  if (game === "checkers") {
    const board = Array(64).fill("");
    for (let r=0;r<3;r++) for(let c=0;c<8;c++) if((r+c)%2) board[r*8+c]="b";
    for (let r=5;r<8;r++) for(let c=0;c<8;c++) if((r+c)%2) board[r*8+c]="r";
    return {board,turn:1,winner:0,draw:false};
  }
  if (game === "ludo") return {tokens:[[-1,-1,-1,-1],[-1,-1,-1,-1]],turn:1,dice:0,phase:"roll",winner:0};
  if (game === "uno") return makeUnoState();
  return {};
}

function buildUnoDeck() {
  const colors = ["red","green","blue","yellow"];
  const deck=[];
  for(const c of colors) {
    deck.push({c,n:0});
    for(let n=1;n<=9;n++) deck.push({c,n},{c,n});
  }
  return deck.sort(() => Math.random() - 0.5);
}
function makeUnoState() {
  const deck=buildUnoDeck(), p1=deck.splice(0,7), p2=deck.splice(0,7), discard=deck.shift();
  return {deck,p1,p2,discard,turn:1,winner:0};
}

async function createRoom(game, invitee=null) {
  if (!currentUser) { toast("Sign in to CUNNACT first.","error"); return ""; }
  const roomRef = doc(collection(db,"gameRooms"));
  const data = {
    game, hostId:currentUser.uid, hostName:currentUser.displayName || currentUser.email || "CUNNACT user",
    guestId:"", guestName:"", status:"waiting", turnUid:currentUser.uid, winnerUid:"", draw:false,
    state:initialState(game), createdAt:serverTimestamp(), updatedAt:serverTimestamp()
  };
  await setDoc(roomRef,data);
  if(invitee?.uid) {
    const inviteRef=doc(collection(db,"gameInvites"));
    await setDoc(inviteRef,{roomId:roomRef.id,game, senderId:currentUser.uid,senderName:data.hostName,receiverId:invitee.uid,status:"pending",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  }
  return roomRef.id;
}

async function sendInvite(game, contact) {
  try {
    const roomId = await createRoom(game, contact);
    if(!roomId) return;
    closeOverlay("inviteOverlay");
    await openRoom(roomId, {asHost:true});
    toast(contact ? `Game invite sent to ${contact.name || contact.email || "your friend"}.` : "Game room created.","success");
  } catch (err) {
    console.error(err);
    toast(err?.code === "permission-denied" ? "Firebase blocked the game room. Deploy the latest rules." : "Could not create the game room.","error");
  }
}

async function joinRoom(roomId) {
  const clean = String(roomId || "").trim().replace(/^.*[?&]room=/i, "").split(/[&#]/)[0];
  if(!clean) { toast("Enter a room code or invite link.","error"); return; }
  try {
    const ref=doc(db,"gameRooms",decodeURIComponent(clean));
    const snap=await getDoc(ref);
    if(!snap.exists()) { toast("That game room does not exist or has expired.","error"); return; }
    const room={id:snap.id,...snap.data()};
    if(room.hostId===currentUser?.uid || room.guestId===currentUser?.uid) {
      closeOverlay("joinOverlay"); await openRoom(room.id); return;
    }
    if(room.guestId) { toast("This game room already has two players.","error"); return; }
    await updateDoc(ref,{guestId:currentUser.uid,guestName:currentUser.displayName||currentUser.email||"CUNNACT user",status:"playing",turnUid:room.hostId,updatedAt:serverTimestamp()});
    closeOverlay("joinOverlay"); await openRoom(room.id); toast(`Joined ${GAME_NAMES[room.game] || "game"}.`,"success");
  } catch(err) {
    console.error(err);
    toast(err?.code === "permission-denied" ? "Firebase blocked joining this room. Deploy the latest rules." : "Could not join the game room.","error");
  }
}

async function openRoom(roomId, {asHost=false}={}) {
  if(!currentUser){toast("Sign in to CUNNACT before opening a game room.","error");return;}
  if(roomUnsub) { roomUnsub(); roomUnsub=null; }
  activeRoomId=roomId;
  const snap=await getDoc(doc(db,"gameRooms",roomId));
  if(!snap.exists()) { toast("Game room no longer exists.","error"); return; }
  const room={id:snap.id,...snap.data()};
  if(!asHost && room.hostId!==currentUser?.uid && room.guestId!==currentUser?.uid && !room.guestId) {
    const body=$('joinOverlay')?.querySelector('.game-modal-body');
    closeOverlay("gameOverlay");
    openOverlay("joinOverlay");
    if(body) body.innerHTML=`<div class="game-room-status"><strong>${esc(GAME_NAMES[room.game]||"Game")}</strong><span>Your friend created this room. Join it to start the match.</span></div><div class="game-toolbar"><button class="game-btn primary" id="deepJoinBtn">Join game</button><button class="game-btn" id="deepCopyBtn">Copy invite link</button></div>`;
    $("deepJoinBtn")?.addEventListener("click",()=>joinRoom(roomId));
    $("deepCopyBtn")?.addEventListener("click",()=>copyText(roomLink(roomId)));
    return;
  }
  openOverlay("gameOverlay");
  setGameHeader(room.game);
  roomUnsub=onSnapshot(doc(db,"gameRooms",roomId), snap2=>{
    if(!snap2.exists()){toast("Game room closed.","error");closeGame();return;}
    const latest={id:snap2.id,...snap2.data()};
    if(latest.guestId && latest.hostId && latest.status==="waiting") updateDoc(doc(db,"gameRooms",roomId),{status:"playing",turnUid:latest.hostId,updatedAt:serverTimestamp()}).catch(()=>{});
    renderOnlineGame(latest);
  },err=>{console.error(err);toast("Live game connection lost.","error");});
}

function closeGame() {
  if(roomUnsub){roomUnsub();roomUnsub=null;}
  activeRoomId="";
  closeOverlay("gameOverlay");
}
function openOverlay(id){const el=$(id);if(!el)return;el.hidden=false;document.body.classList.add("game-modal-open");}
function closeOverlay(id){const el=$(id);if(!el)return;el.hidden=true;if(!document.querySelector('.game-overlay:not([hidden])'))document.body.classList.remove("game-modal-open");}
function setGameHeader(game){const card=document.querySelector(`[data-game="${CSS.escape(game)}"]`);$('gameTitle').textContent=GAME_NAMES[game]||card?.dataset.title||game;$('gameSubtitle').textContent=card?.dataset.subtitle||"";}
function copyText(value){navigator.clipboard?.writeText(value).then(()=>toast("Invite link copied.","success")).catch(()=>{prompt("Copy this invite link:",value);});}

async function loadContacts() {
  if(!currentUser) return [];
  try {
    const snap=await getDocs(query(collection(db,"conversations"),where("members","array-contains",currentUser.uid),limit(100)));
    const ids=new Set();
    snap.docs.forEach(d=>{const c=d.data();if(c.type!=="group"){const uid=(c.members||[]).find(x=>x!==currentUser.uid);if(uid)ids.add(uid);}});
    const rows=[];
    for(const uid of ids){try{const u=await getDoc(doc(db,"users",uid));if(u.exists())rows.push({uid,...u.data()});}catch{}}
    currentContacts=rows.sort((a,b)=>String(a.name||a.displayName||a.username||a.email||"").localeCompare(String(b.name||b.displayName||b.username||b.email||"")));
  } catch(err){console.warn("Gaming contacts unavailable",err);currentContacts=[];}
  return currentContacts;
}

function subscribeInvites() {
  if(inviteUnsub) inviteUnsub();
  if(!currentUser) return;
  inviteUnsub=onSnapshot(query(collection(db,"gameInvites"),where("receiverId","==",currentUser.uid),limit(50)),snap=>{
    pendingInvites=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status==="pending");
    renderInviteBanner();
  },err=>{console.warn("Game invite listener",err);});
}
function renderInviteBanner() {
  const box=$("incomingGameInvites");
  if(!box)return;
  if(!pendingInvites.length){box.hidden=true;box.innerHTML="";return;}
  box.hidden=false;
  box.innerHTML=`<div class="invite-banner-title">Game invitations</div><div class="invite-list">${pendingInvites.map(inv=>`<div class="invite-row"><div class="invite-row-main"><strong>${esc(inv.senderName||"CUNNACT friend")} invited you to ${esc(GAME_NAMES[inv.game]||"a game")}</strong><small>Play online from another device</small></div><div class="invite-row-actions"><button class="game-btn primary" data-accept-invite="${esc(inv.id)}">Play</button><button class="game-btn" data-decline-invite="${esc(inv.id)}">Decline</button></div></div>`).join("")}</div>`;
  box.querySelectorAll("[data-accept-invite]").forEach(btn=>btn.addEventListener("click",()=>acceptInvite(btn.dataset.acceptInvite)));
  box.querySelectorAll("[data-decline-invite]").forEach(btn=>btn.addEventListener("click",()=>declineInvite(btn.dataset.declineInvite)));
}
async function acceptInvite(inviteId) {
  const inv=pendingInvites.find(x=>x.id===inviteId); if(!inv||!currentUser)return;
  try {
    const roomSnap=await getDoc(doc(db,"gameRooms",inv.roomId));
    if(!roomSnap.exists()){toast("The game room was closed.","error");await updateDoc(doc(db,"gameInvites",inviteId),{status:"declined",updatedAt:serverTimestamp()});return;}
    const room={id:roomSnap.id,...roomSnap.data()};
    if(room.guestId && room.guestId!==currentUser.uid){toast("That game already has two players.","error");return;}
    await updateDoc(doc(db,"gameRooms",inv.roomId),{guestId:currentUser.uid,guestName:currentUser.displayName||currentUser.email||"CUNNACT user",status:"playing",turnUid:room.hostId,updatedAt:serverTimestamp()});
    await updateDoc(doc(db,"gameInvites",inviteId),{status:"accepted",updatedAt:serverTimestamp()});
    await openRoom(inv.roomId); toast("Joined the game.","success");
  } catch(err){console.error(err);toast(err?.code==="permission-denied"?"Firebase blocked accepting the invite. Deploy the latest rules.":"Could not join the game.","error");}
}
async function declineInvite(inviteId){try{await updateDoc(doc(db,"gameInvites",inviteId),{status:"declined",updatedAt:serverTimestamp()});}catch(err){console.error(err);toast("Could not decline the invite.","error");}}

function renderInviteModal(game) {
  $('inviteTitle').textContent=`Invite a friend to ${GAME_NAMES[game]}`;
  $('inviteSubtitle').textContent="Choose a connected CUNNACT contact or create a shareable room link.";
  const box=$('inviteBody');
  box.innerHTML=`<div class="contact-picker" id="gameContactPicker"><div class="game-empty">Loading contacts…</div></div><div class="game-toolbar"><button class="game-btn primary" id="sendGameInviteBtn">Send invite</button><button class="game-btn" id="shareRoomBtn">Create shareable room</button></div><p class="game-help">Online mode uses a live CUNNACT game room. Your friend can play from another phone or computer.</p>`;
  loadContacts().then(contacts=>{
    const list=$('gameContactPicker');
    if(!list)return;
    if(!contacts.length){list.innerHTML='<div class="game-empty">No connected contacts found yet. You can still create a shareable room.</div>';return;}
    list.innerHTML=contacts.map((u,i)=>`<label class="contact-choice"><input type="radio" name="gameContact" value="${esc(u.uid)}" ${i===0?'checked':''}><span class="contact-choice-main"><strong>${esc(u.name||u.displayName||"CUNNACT user")}</strong><small>${esc(u.username?`@${u.username}`:u.email||"Connected contact")}</small></span></label>`).join("");
  });
  $('sendGameInviteBtn').onclick=async()=>{const uid=box.querySelector('input[name="gameContact"]:checked')?.value;const contact=currentContacts.find(x=>x.uid===uid);if(!contact){toast("Select a contact first.","error");return;}await sendInvite(game,contact);};
  $('shareRoomBtn').onclick=async()=>{try{const roomId=await createRoom(game,null);if(!roomId)return;closeOverlay("inviteOverlay");await openRoom(roomId,{asHost:true});copyText(roomLink(roomId));toast("Shareable game room created.","success");}catch(err){console.error(err);toast("Could not create the game room.","error");}};
}

function beginGame(game, mode="computer") {
  openOverlay("gameOverlay"); setGameHeader(game);
  if(mode==="online"){renderInviteModal(game);closeOverlay("gameOverlay");openOverlay("inviteOverlay");return;}
  if(game==="ttt") return renderLocalTTT(mode);
  if(game==="c4") return renderLocalC4(mode);
  if(game==="chess") return renderLocalChess(mode);
  if(game==="checkers") return renderLocalCheckers(mode);
  if(game==="ludo") return renderLocalLudo(mode);
  if(game==="uno") return renderLocalUNO(mode);
  if(game==="pong") return renderLocalPong(mode);
  if(game==="candy") return renderCandyCrush();
}

function renderOnlineGame(room) {
  const body=$('gameBody');
  if(room.status==="waiting") {
    body.innerHTML=`<div class="game-room-status"><strong>Waiting for your friend…</strong><span>${esc(room.guestName||"Invite sent — waiting for the second player")}</span><div class="game-room-code">${esc(roomLink(room.id))}</div></div><div class="game-toolbar"><button class="game-btn" id="copyRoomBtn">Copy invite link</button><button class="game-btn danger" id="leaveRoomBtn">Close room</button></div>`;
    $('copyRoomBtn').onclick=()=>copyText(roomLink(room.id)); $('leaveRoomBtn').onclick=closeGame; return;
  }
  if(room.status==="finished") {
    const result=room.draw?"Draw":room.winnerUid===currentUser?.uid?"You won 🎉":"You lost";
    body.innerHTML=`<div class="game-status"><strong>${result}</strong></div><div class="game-toolbar"><button class="game-btn primary" id="onlineNewRoomBtn">New room</button><button class="game-btn" id="onlineCloseBtn">Close</button></div>`;
    $('onlineNewRoomBtn').onclick=()=>{closeGame();renderInviteModal(room.game);openOverlay("inviteOverlay")};$('onlineCloseBtn').onclick=closeGame;return;
  }
  if(room.game==="ttt") return paintOnlineTTT(room);
  if(room.game==="c4") return paintOnlineC4(room);
  if(room.game==="chess") return paintOnlineChess(room);
  if(room.game==="checkers") return paintOnlineCheckers(room);
  if(room.game==="ludo") return paintOnlineLudo(room);
  if(room.game==="uno") return paintOnlineUNO(room);
}

async function pushRoom(room, state, turnUid, extra={}) {
  try { await updateDoc(doc(db,"gameRooms",room.id),{state,turnUid,updatedAt:serverTimestamp(),...extra}); }
  catch(err){console.error(err);toast(err?.code==="permission-denied"?"That move was rejected by Firebase rules.":"Could not sync that move.","error");}
}

function checkTTT(board){const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];for(const [a,b,c] of lines)if(board[a]&&board[a]===board[b]&&board[a]===board[c])return board[a];return "";}
function paintOnlineTTT(room){const s=room.state||initialState("ttt"), myMark=room.hostId===currentUser.uid?"X":"O"; const status=s.winner?`${s.winner} wins`:s.draw?"Draw":isMyTurn(room)?`Your turn (${myMark})`:`${room.hostId===room.turnUid?"X":"O"}'s turn`;
  $('gameBody').innerHTML=`<div class="game-status">${esc(status)}</div><div class="ttt-board">${s.board.map((v,i)=>`<button class="ttt-cell" data-i="${i}" ${v||!isMyTurn(room)?"disabled":""}>${esc(v)}</button>`).join("")}</div><div class="game-toolbar"><button class="game-btn" id="copyOnlineLink">Copy invite link</button></div>`;
  qsa(".ttt-cell").forEach(btn=>btn.onclick=()=>{const i=Number(btn.dataset.i);if(s.board[i]||!isMyTurn(room)||s.winner)return;const board=[...s.board];board[i]=myMark;const winner=checkTTT(board);pushRoom(room,{board,turn:myMark===stateFor(room,"X")?1:2,winner: winner?winner:"",draw:!winner&&board.every(Boolean)},winner?(room.hostId===currentUser.uid?room.hostId:room.guestId):(!winner&&board.every(Boolean)?room.turnUid:(room.turnUid===room.hostId?room.guestId:room.hostId)),{status:winner||board.every(Boolean)?"finished":"playing",winnerUid:winner?(winner===myMark?currentUser.uid:otherUid(room)):"",draw:!winner&&board.every(Boolean)});});
  $('copyOnlineLink').onclick=()=>copyText(roomLink(room.id));
}
function stateFor(room){return room.hostId===currentUser.uid?"X":"O";}

function c4Winner(board,p){const R=6,C=7;for(let r=0;r<R;r++)for(let c=0;c<C;c++)if(board[r*C+c]===p)for(const [dr,dc] of [[1,0],[0,1],[1,1],[1,-1]]){let ok=true;for(let k=1;k<4;k++){const rr=r+dr*k,cc=c+dc*k;if(rr<0||rr>=R||cc<0||cc>=C||board[rr*C+cc]!==p){ok=false;break}}if(ok)return true;}return false;}
function paintOnlineC4(room){const s=room.state||initialState("c4"), me=room.hostId===currentUser.uid?1:2;const status=s.winner?`Player ${s.winner} wins`:s.draw?"Draw":isMyTurn(room)?`Your turn — Player ${me}`:`Player ${me===1?2:1}'s turn`;
  $('gameBody').innerHTML=`<div class="game-status">${esc(status)}</div><div class="c4-wrap"><div class="c4-board">${s.board.map((v,i)=>`<button class="c4-cell ${v===1?'p1':v===2?'p2':''}" data-i="${i}" ${!isMyTurn(room)||s.winner?"disabled":""} aria-label="Column ${(i%7)+1}"></button>`).join("")}</div></div><div class="game-toolbar"><button class="game-btn" id="copyC4Link">Copy invite link</button></div>`;
  qsa(".c4-cell").forEach(btn=>btn.onclick=()=>{const c=Number(btn.dataset.i)%7;if(!isMyTurn(room)||s.winner||s.board[c])return;const b=[...s.board];let row=-1;for(let r=5;r>=0;r--)if(!b[r*7+c]){b[r*7+c]=me;row=r;break}if(row<0)return;const winner=c4Winner(b,me);const draw=!winner&&b.every(Boolean);const next=room.turnUid===room.hostId?room.guestId:room.hostId;pushRoom(room,{...s,board:b,winner:winner?me:0,draw},next,{status:winner||draw?"finished":"playing",winnerUid:winner?currentUser.uid:"",draw});});$('copyC4Link').onclick=()=>copyText(roomLink(room.id));}

function paintChessBoard(game,room,online){const files=["a","b","c","d","e","f","g","h"], glyph={p:"♟",r:"♜",n:"♞",b:"♝",q:"♛",k:"♚",P:"♙",R:"♖",N:"♘",B:"♗",Q:"♕",K:"♔"};const myColor=online?(room.hostId===currentUser.uid?"w":"b"):null;let selected=null;function paint(){const m={};game.board().forEach((row,r)=>row.forEach((p,c)=>{if(p)m[files[c]+(8-r)]=p.color==="w"?p.type.toUpperCase():p.type}));$('gameBody').innerHTML=`<div class="game-status">${game.isCheckmate()?"Checkmate":game.isDraw()?"Draw":(online&&!isMyTurn(room)?"Waiting for opponent…":(game.turn()==="w"?"White to move":"Black to move"))}</div><div class="chess-board">${Array.from({length:64},(_,i)=>{const r=Math.floor(i/8),c=i%8,sq=files[c]+(8-r),pc=m[sq],moves=selected?game.moves({square:selected,verbose:true}):[];return `<button class="chess-square ${(r+c)%2?'dark':'light'} ${selected===sq?'sel':''} ${moves.some(x=>x.to===sq)?'move':''}" data-sq="${sq}">${pc?`<span class="chess-piece">${glyph[pc]}</span>`:""}</button>`}).join("")}</div><div class="game-toolbar"><button class="game-btn" id="copyChessLink">Copy invite link</button></div>`;qsa(".chess-square").forEach(btn=>btn.onclick=async()=>{const sq=btn.dataset.sq;if(online&&(!isMyTurn(room)||((room.hostId===currentUser.uid)!=(game.turn()==="w"))))return;const piece=game.get(sq);if(selected){const legal=game.moves({square:selected,verbose:true});if(legal.some(m=>m.to===sq)){const from=selected;game.move({from,to:sq,promotion:"q"});selected=null;if(online){const mate=game.isCheckmate(),draw=game.isDraw();const next=room.turnUid===room.hostId?room.guestId:room.hostId;await pushRoom(room,{fen:game.fen(),lastMove:{from,to:sq},winner:mate?1:0,draw},next,{status:mate||draw?"finished":"playing",winnerUid:mate?currentUser.uid:"",draw});}paint();return;}selected=null;}if(piece&&piece.color===game.turn())selected=sq;paint();});$('copyChessLink').onclick=()=>copyText(roomLink(room.id));}
  paint();}
function paintOnlineChess(room){if(!window.Chess){$("gameBody").innerHTML='<div class="game-empty">Chess needs a network connection to load its game engine.</div>';return;}const game=new window.Chess(room.state?.fen||"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");paintChessBoard(game,room,true);}
function renderLocalChess(mode){if(!window.Chess){toast("Chess engine could not load. Check your internet connection.","error");return;}const game=new window.Chess();paintChessBoard(game,null,false);}

function checkersMoves(board,idx){const p=board[idx];if(!p)return[];const row=Math.floor(idx/8),col=idx%8,black=p.toLowerCase()==="b";const king=p===p.toUpperCase();const dirs=king?[[-1,-1],[-1,1],[1,-1],[1,1]]:(black?[[1,-1],[1,1]]:[[-1,-1],[-1,1]]);const out=[];for(const[dr,dc] of dirs){const r=row+dr,c=col+dc;if(r>=0&&r<8&&c>=0&&c<8&&!board[r*8+c])out.push({to:r*8+c,cap:-1});else if(r>=0&&r<8&&c>=0&&c<8&&board[r*8+c]&&board[r*8+c].toLowerCase()!==p.toLowerCase()){const r2=row+dr*2,c2=col+dc*2;if(r2>=0&&r2<8&&c2>=0&&c2<8&&!board[r2*8+c2])out.push({to:r2*8+c2,cap:r*8+c});}}return out;}
function checkersAll(board,prefix){const arr=[];for(let i=0;i<64;i++)if(board[i]?.toLowerCase()===prefix.toLowerCase())for(const m of checkersMoves(board,i))arr.push({from:i,...m});return arr;}
function paintOnlineCheckers(room){const s=room.state||initialState("checkers"),me=room.hostId===currentUser.uid?"r":"b";let selected=-1;const paint=()=>{$('gameBody').innerHTML=`<div class="game-status">${s.winner?(s.winner===1?"Red wins":"Black wins"):isMyTurn(room)?`Your turn (${me==='r'?'Red':'Black'})`:`Opponent's turn`}</div><div class="checkers-board">${s.board.map((v,i)=>{const r=Math.floor(i/8),c=i%8;return `<div class="checker-cell ${(r+c)%2?'dark':'light'}">${v?`<button class="checker-piece ${v.toLowerCase()==='r'?'red':'black'} ${v===v.toUpperCase()?'king':''}" data-i="${i}" ${!isMyTurn(room)?'disabled':''}></button>`:""}</div>`}).join("")}</div><div class="game-toolbar"><button class="game-btn" id="copyCheckersLink">Copy invite link</button></div>`;qsa(".checker-piece").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.i);if(selected<0){if(s.board[i]?.toLowerCase()===me)selected=i;paint();return;}const mv=checkersMoves(s.board,selected).find(x=>x.to===i);if(!mv){selected=-1;paint();return;}const board=[...s.board];const piece=board[selected];board[selected]="";board[i]=piece;if(mv.cap>=0)board[mv.cap]="";const nr=Math.floor(i/8);if(piece==="r"&&nr===0)board[i]="R";if(piece==="b"&&nr===7)board[i]="B";const opp=me==='r'?'b':'r';const winner=checkersAll(board,opp).length?0:(me==='r'?1:2);const next=room.turnUid===room.hostId?room.guestId:room.hostId;pushRoom(room,{board,turn:me==='r'?2:1,winner,draw:false},next,{status:winner?"finished":"playing",winnerUid:winner?currentUser.uid:"",draw:false});selected=-1;});$('copyCheckersLink').onclick=()=>copyText(roomLink(room.id));};paint();}
function renderLocalCheckers(mode){const board=initialState("checkers").board;let turn='r',selected=-1;const body=$('gameBody');function paint(){body.innerHTML=`<div class="game-status">${turn==='r'?'Red':'Black'} turn · local 2 player</div><div class="checkers-board">${board.map((v,i)=>{const r=Math.floor(i/8),c=i%8;return `<div class="checker-cell ${(r+c)%2?'dark':'light'}">${v?`<button class="checker-piece ${v.toLowerCase()==='r'?'red':'black'} ${v===v.toUpperCase()?'king':''}" data-i="${i}"></button>`:""}</div>`}).join("")}</div><div class="game-toolbar"><button class="game-btn primary" id="checkersReset">New game</button></div>`;qsa(".checker-piece").forEach(b=>b.onclick=()=>{const i=Number(b.dataset.i);if(selected<0){if(board[i]?.toLowerCase()===turn)selected=i;paint();return;}const mv=checkersMoves(board,selected).find(x=>x.to===i);if(!mv){selected=-1;paint();return;}const piece=board[selected];board[selected]="";board[i]=piece;if(mv.cap>=0)board[mv.cap]="";const nr=Math.floor(i/8);if(piece==='r'&&nr===0)board[i]='R';if(piece==='b'&&nr===7)board[i]='B';turn=turn==='r'?'b':'r';selected=-1;paint();});$('checkersReset').onclick=()=>{const fresh=initialState("checkers").board;for(let i=0;i<64;i++)board[i]=fresh[i];turn='r';selected=-1;paint();}}paint();}

function legalLudoMove(tokens,player,dice,i){const pos=tokens[player][i];return (pos===-1&&dice===6)||(pos>=0&&pos<57&&pos+dice<=57);}
function paintLudo(room,s,online){const me=room?room.hostId===currentUser.uid?0:1:0;const body=$('gameBody'),status=s.winner?`${s.winner===me+1?'You win 🎉':'You lose'}`:online?(isMyTurn(room)?(s.phase==='roll'?"Your turn — roll the dice":"Choose a token"):'Waiting for opponent…'):`${me===0?'Red':'Green'} turn — ${s.phase==='roll'?'roll':'choose token'}`;body.innerHTML=`<div class="game-status">${esc(status)}</div><div class="dice-box"><div class="dice">${s.dice||'–'}</div><button class="game-btn primary" id="ludoRoll" ${s.phase!=='roll'||(online&&!isMyTurn(room))||s.winner?'disabled':''}>Roll dice</button></div><div class="ludo-board">${Array.from({length:225},(_,i)=>{const r=Math.floor(i/15),c=i%15,tokenIdx=s.tokens.findIndex((arr)=>arr.some(x=>x>=0&&x<58&&x===((r*15+c)%58)));const token=tokenIdx>=0?`<span class="ludo-token ${tokenIdx===0?'red':'green'}"></span>`:'';let cls='ludo-cell';if(r<6&&c<6)cls+=' ludo-home-red';else if(r<6&&c>8)cls+=' ludo-home-green';else cls+=' ludo-path';return `<div class="${cls}">${token}</div>`}).join("")}</div><div class="game-toolbar">${s.tokens[me].map((x,i)=>`<button class="game-btn" data-ludo-token="${i}" ${s.phase!=='move'||(online&&!isMyTurn(room))||!legalLudoMove(s.tokens,me,s.dice,i)?'disabled':''}>Token ${i+1} · ${x<0?'Home':x+'/57'}</button>`).join("")}</div>`;
 body.querySelector('#ludoRoll').onclick=()=>{const dice=rand(6)+1;const nextState={...s,dice,phase:'move'};if(!s.tokens[me].some((_,i)=>legalLudoMove(s.tokens,me,dice,i))){nextState.dice=0;nextState.phase='roll';if(room)nextState.turn=me===0?2:1;if(room)pushRoom(room,nextState,room.turnUid===room.hostId?room.guestId:room.hostId,{status:'playing'});else{currentLocalLudo=nextState;paintLudo(null,currentLocalLudo,false);}return;}if(room)pushRoom(room,nextState,room.turnUid,{});else{currentLocalLudo=nextState;paintLudo(null,currentLocalLudo,false);}};
 body.querySelectorAll('[data-ludo-token]').forEach(btn=>btn.onclick=()=>{const i=Number(btn.dataset.ludoToken);if(!legalLudoMove(s.tokens,me,s.dice,i))return;const tokens=s.tokens.map(a=>[...a]);tokens[me][i]=tokens[me][i]===-1?1:tokens[me][i]+s.dice;const win=tokens[me].every(x=>x===57);let next=s.turn;if(!win&&s.dice!==6)next=me===0?2:1;const ns={tokens,dice:0,phase: 'roll',turn:next,winner:win?me+1:0};if(room){const nextUid=next===1?room.hostId:room.guestId;pushRoom(room,ns,nextUid,{status:win?'finished':'playing',winnerUid:win?currentUser.uid:'',draw:false});}else{currentLocalLudo=ns;paintLudo(null,currentLocalLudo,false);}});
}
let currentLocalLudo=initialState('ludo');
function paintOnlineLudo(room){paintLudo(room,room.state||initialState('ludo'),true)}
function renderLocalLudo(mode){currentLocalLudo=initialState('ludo');paintLudo(null,currentLocalLudo,false);}

function paintOnlineUNO(room){const s=room.state||initialState('uno'),me=room.hostId===currentUser.uid?1:2,myHand=me===1?s.p1:s.p2,oppHand=me===1?s.p2:s.p1;const status=s.winner?`Player ${s.winner} wins`:isMyTurn(room)?"Your turn":"Opponent's turn";$('gameBody').innerHTML=`<div class="game-status">${esc(status)}</div><div class="uno-center"><div class="game-score"><div class="score-pill"><strong>${esc(s.discard?.n??'')}</strong><span>Current card</span></div><div class="score-pill"><strong>${oppHand.length}</strong><span>Opponent cards</span></div><div class="score-pill"><strong>${myHand.length}</strong><span>Your cards</span></div></div><div class="uno-cards">${myHand.map((c,i)=>`<button class="uno-card uno-${c.c}" data-uno-i="${i}" ${!isMyTurn(room)||s.winner?'disabled':''}><span>${esc(c.n)}</span><small>${esc(c.c)}</small></button>`).join("")}</div><div class="game-footnote">Opponent's cards stay visually hidden. Match color or number.</div></div><div class="game-toolbar"><button class="game-btn" id="unoOnlineDraw" ${!isMyTurn(room)||s.winner?'disabled':''}>Draw card</button><button class="game-btn" id="copyUnoLink">Copy invite link</button></div>`;qsa('[data-uno-i]').forEach(b=>b.onclick=()=>{const idx=Number(b.dataset.unoI);const card=myHand[idx];if(!isUnoPlayable(card,s.discard)||!isMyTurn(room))return;const ns={...s,deck:[...s.deck],p1:[...s.p1],p2:[...s.p2]};const hand=me===1?ns.p1:ns.p2;ns.discard=hand.splice(idx,1)[0];if(!hand.length){ns.winner=me;return pushRoom(room,ns,room.turnUid,{status:'finished',winnerUid:currentUser.uid,draw:false});}ns.turn=me===1?2:1;const nextUid=me===1?room.guestId:room.hostId;pushRoom(room,ns,nextUid,{status:'playing',winnerUid:'',draw:false});});$('unoOnlineDraw').onclick=()=>{if(!isMyTurn(room))return;const ns={...s,deck:[...s.deck],p1:[...s.p1],p2:[...s.p2]};if(!ns.deck.length)ns.deck=buildUnoDeck();const hand=me===1?ns.p1:ns.p2;const c=ns.deck.pop();if(c)hand.push(c);ns.turn=me===1?2:1;pushRoom(room,ns,me===1?room.guestId:room.hostId,{status:'playing'});};$('copyUnoLink').onclick=()=>copyText(roomLink(room.id));}
function isUnoPlayable(card,discard){return card?.c===discard?.c||card?.n===discard?.n;}
function renderLocalUNO(mode){let s=makeUnoState(),turn=1;const body=$('gameBody');function paint(){const hand=turn===1?s.p1:s.p2;body.innerHTML=`<div class="game-status">${turn===1?'Player 1':'Player 2'} turn</div><div class="uno-center"><div class="game-score"><div class="score-pill"><strong>${s.discard.n}</strong><span>Current card</span></div><div class="score-pill"><strong>${s.p1.length}/${s.p2.length}</strong><span>Cards left</span></div></div><div class="uno-cards">${hand.map((c,i)=>`<button class="uno-card uno-${c.c}" data-local-uno="${i}"><span>${c.n}</span><small>${c.c}</small></button>`).join("")}</div></div><div class="game-toolbar"><button class="game-btn" id="localUnoDraw">Draw card</button><button class="game-btn primary" id="localUnoReset">New game</button></div>`;qsa('[data-local-uno]').forEach(b=>b.onclick=()=>{const idx=Number(b.dataset.localUno),h=turn===1?s.p1:s.p2,c=h[idx];if(!isUnoPlayable(c,s.discard))return;s.discard=h.splice(idx,1)[0];if(!h.length){toast(`${turn===1?'Player 1':'Player 2'} wins!`,'success');return;}turn=turn===1?2:1;paint();});$('localUnoDraw').onclick=()=>{const h=turn===1?s.p1:s.p2;if(!s.deck.length)s.deck=buildUnoDeck();h.push(s.deck.pop());turn=turn===1?2:1;paint();};$('localUnoReset').onclick=()=>{s=makeUnoState();turn=1;paint();}}paint();}

function renderLocalTTT(mode){let board=Array(9).fill(''),turn='X',over=false;const body=$('gameBody');function paint(){body.innerHTML=`<div class="game-status">${over?'Game over':mode==='computer'?(turn==='X'?'Your turn':'Computer turn'):`${turn}'s turn`}</div><div class="ttt-board">${board.map((v,i)=>`<button class="ttt-cell" data-i="${i}" ${v||over||turn==='O'&&mode==='computer'?'disabled':''}>${v}</button>`).join('')}</div><div class="game-toolbar"><button class="game-btn primary" id="tttLocalReset">New game</button></div>`;qsa('.ttt-cell').forEach(b=>b.onclick=()=>move(Number(b.dataset.i)));$('tttLocalReset').onclick=()=>{board=Array(9).fill('');turn='X';over=false;paint();};if(mode==='computer'&&turn==='O'&&!over)setTimeout(ai,240)}function win(b){return checkTTT(b)}function move(i){if(over||board[i]||(mode==='computer'&&turn==='O'))return;board[i]=turn;const w=win(board);if(w){over=true;toast(`${w} wins!`,'success');paint();return;}if(board.every(Boolean)){over=true;paint();return;}turn=turn==='X'?'O':'X';paint();}function ai(){if(over||turn!=='O')return;const empties=board.map((v,i)=>v?null:i).filter(x=>x!==null);board[empties[rand(empties.length)]]='O';const w=win(board);if(w)over=true;else if(board.every(Boolean))over=true;else turn='X';paint();}paint();}
function renderLocalC4(mode){let board=Array(42).fill(0),turn=1,over=false;const body=$('gameBody');function paint(){body.innerHTML=`<div class="game-status">${over?'Game over':mode==='computer'?(turn===1?'Your turn':'Computer turn'):`Player ${turn}'s turn`}</div><div class="c4-wrap"><div class="c4-board">${board.map((v,i)=>`<button class="c4-cell ${v===1?'p1':v===2?'p2':''}" data-i="${i}" ${over||turn===2&&mode==='computer'?'disabled':''}></button>`).join('')}</div></div><div class="game-toolbar"><button class="game-btn primary" id="c4LocalReset">New game</button></div>`;qsa('.c4-cell').forEach(b=>b.onclick=()=>move(Number(b.dataset.i)%7));$('c4LocalReset').onclick=()=>{board=Array(42).fill(0);turn=1;over=false;paint();};if(mode==='computer'&&turn===2&&!over)setTimeout(ai,280)}function move(c){if(over)return;let r=-1;for(let rr=5;rr>=0;rr--)if(!board[rr*7+c]){board[rr*7+c]=turn;r=rr;break;}if(r<0)return;if(c4Winner(board,turn)){over=true;toast(`Player ${turn} wins!`,'success');paint();return;}if(board.every(Boolean)){over=true;paint();return;}turn=turn===1?2:1;paint();}function ai(){const cols=[3,2,4,1,5,0,6].filter(c=>!board[c]);move(cols[0]??3)}paint();}

function renderLocalPong(mode){let raf=0;const body=$('gameBody');body.innerHTML=`<div class="game-status">${mode==='computer'?'Arrow ↑/↓ to move. Right paddle is computer.':'Player 1: Arrow keys · Player 2: W/S'}</div><div class="canvas-wrap"><canvas id="pongCanvas" class="game-canvas" width="960" height="540"></canvas></div><div class="game-toolbar"><button class="game-btn primary" id="pongRestart">Restart</button></div>`;const c=$('pongCanvas'),ctx=c.getContext('2d');let s={py:220,cy:220,bx:480,by:270,bvx:5,bvy:3,score:[0,0]},keys={};const onKey=e=>{keys[e.key.toLowerCase()]=true},upKey=e=>{keys[e.key.toLowerCase()]=false};window.addEventListener('keydown',onKey);window.addEventListener('keyup',upKey);function reset(){s={py:220,cy:220,bx:480,by:270,bvx:5,bvy:3,score:[0,0]}}function loop(){if(!$('pongCanvas')){window.removeEventListener('keydown',onKey);window.removeEventListener('keyup',upKey);cancelAnimationFrame(raf);return;}if(keys.arrowup)s.py-=7;if(keys.arrowdown)s.py+=7;if(mode!=='computer'){if(keys.w)s.cy-=7;if(keys.s)s.cy+=7}else s.cy+=(s.by-(s.cy+40))*.08;s.py=Math.max(0,Math.min(460,s.py));s.cy=Math.max(0,Math.min(460,s.cy));s.bx+=s.bvx;s.by+=s.bvy;if(s.by<10||s.by>530)s.bvy*=-1;if(s.bx<100&&s.by>s.py&&s.by<s.py+80&&s.bvx<0){s.bvx=Math.abs(s.bvx)+.15;}if(s.bx>860&&s.by>s.cy&&s.by<s.cy+80&&s.bvx>0)s.bvx=-Math.abs(s.bvx)-.15;if(s.bx<0){s.score[1]++;reset();}if(s.bx>960){s.score[0]++;reset();}ctx.fillStyle='#0b1220';ctx.fillRect(0,0,960,540);ctx.fillStyle='#fff';ctx.fillRect(40,s.py,18,80);ctx.fillRect(902,s.cy,18,80);ctx.beginPath();ctx.arc(s.bx,s.by,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(255,255,255,.2)';ctx.fillRect(478,0,4,540);ctx.font='700 46px Inter';ctx.textAlign='center';ctx.fillText(s.score[0],430,62);ctx.fillText(s.score[1],530,62);raf=requestAnimationFrame(loop)}$('pongRestart').onclick=reset;loop();}

function renderCandyCrush(){const body=$('gameBody');const N=8,candies=['🍬','🍭','🧁','🍫','🍓','🍋'];let board=Array.from({length:N*N},()=>rand(candies.length)),score=0,selected=-1,moves=20;function at(r,c){return r*N+c}function findMatches(){const marked=new Set();for(let r=0;r<N;r++){let start=0;while(start<N){let end=start+1;while(end<N&&board[at(r,end)]===board[at(r,start)])end++;if(end-start>=3)for(let c=start;c<end;c++)marked.add(at(r,c));start=end;}}for(let c=0;c<N;c++){let start=0;while(start<N){let end=start+1;while(end<N&&board[at(end,c)]===board[at(start,c)])end++;if(end-start>=3)for(let r=start;r<end;r++)marked.add(at(r,c));start=end;}}return marked;}function settle(){let matches=findMatches();if(!matches.size)return false;score+=matches.size*10;for(const i of matches)board[i]=-1;for(let c=0;c<N;c++){const vals=[];for(let r=N-1;r>=0;r--)if(board[at(r,c)]!==-1)vals.push(board[at(r,c)]);for(let r=N-1;r>=0;r--)board[at(r,c)]=vals.shift()??rand(candies.length);}return true;}function fillInitial(){for(let i=0;i<board.length;i++){let guard=0;do{board[i]=rand(candies.length);guard++;}while(guard<20&&((i>=2&&board[i-1]===board[i]&&board[i-2]===board[i])||(i>=N&&board[i-N]===board[i]&&i>=2*N&&board[i-2*N]===board[i])));}}fillInitial();function paint(){body.innerHTML=`<div class="game-score"><div class="score-pill"><strong>${score}</strong><span>Score</span></div><div class="score-pill"><strong>${moves}</strong><span>Moves</span></div></div><div class="candy-board">${board.map((v,i)=>`<button class="candy-cell ${selected===i?'selected':''}" data-candy-i="${i}">${candies[v]}</button>`).join('')}</div><div class="candy-help">Swap adjacent candies. Three or more matching candies clear automatically.</div><div class="game-toolbar"><button class="game-btn primary" id="candyReset">New game</button></div>`;qsa('[data-candy-i]').forEach(b=>b.onclick=()=>tap(Number(b.dataset.candyI)));$('candyReset').onclick=()=>{score=0;moves=20;selected=-1;board=Array.from({length:N*N},()=>rand(candies.length));fillInitial();paint();}}function tap(i){if(moves<=0)return;if(selected<0){selected=i;paint();return;}const a=selected,b=i,ar=Math.floor(a/N),ac=a%N,br=Math.floor(b/N),bc=b%N;if(Math.abs(ar-br)+Math.abs(ac-bc)!==1){selected=i;paint();return;}[board[a],board[b]]=[board[b],board[a]];if(!findMatches().size){[board[a],board[b]]=[board[b],board[a]];selected=-1;paint();return;}moves--;selected=-1;while(settle()){}paint();}paint();}

function openGame(id){
  closeGame();
  openOverlay("gameOverlay");setGameHeader(id);
  const online=ONLINE_GAMES.has(id), hasComputer=!['candy'].includes(id), hasLocal=!['candy'].includes(id);
  $('gameBody').innerHTML=`<div class="game-status">Choose how you want to play.</div><div class="game-mode-row">${online?'<button class="game-btn primary" id="modeOnline">Play with Friend</button>':''}${hasComputer?'<button class="game-btn" id="modeComputer">Play with Computer</button>':''}${hasLocal?'<button class="game-btn" id="modeLocal">2 Players on this device</button>':''}${id==='candy'?'<button class="game-btn primary" id="modeSolo">Play Solo</button>':''}</div>`;
  $('modeOnline')?.addEventListener('click',()=>{closeOverlay('gameOverlay');renderInviteModal(id);openOverlay('inviteOverlay');});
  $('modeComputer')?.addEventListener('click',()=>beginGame(id,'computer'));
  $('modeLocal')?.addEventListener('click',()=>beginGame(id,'local'));
  $('modeSolo')?.addEventListener('click',()=>beginGame(id,'solo'));
}

function initTheme(){document.documentElement.dataset.theme=localStorage.getItem('cunnact_theme')==='dark'?'dark':'light';$('gameThemeBtn').onclick=()=>{const d=document.documentElement.dataset.theme==='dark';document.documentElement.dataset.theme=d?'light':'dark';localStorage.setItem('cunnact_theme',d?'light':'dark');};}
function boot(){
  initTheme();
  qsa('[data-game]').forEach(card=>{card.querySelector('.game-play-btn')?.addEventListener('click',()=>openGame(card.dataset.game));card.querySelector('.game-invite-btn')?.addEventListener('click',()=>{renderInviteModal(card.dataset.game);openOverlay('inviteOverlay');});});
  $('gameClose').onclick=closeGame;$('inviteClose').onclick=()=>closeOverlay('inviteOverlay');$('joinClose').onclick=()=>closeOverlay('joinOverlay');$('joinRoomBtn').onclick=()=>openOverlay('joinOverlay');$('joinRoomConfirm').onclick=()=>joinRoom($('joinRoomCode').value);$('gameOverlay').addEventListener('click',e=>{if(e.target.id==='gameOverlay')closeGame();});$('inviteOverlay').addEventListener('click',e=>{if(e.target.id==='inviteOverlay')closeOverlay('inviteOverlay');});$('joinOverlay').addEventListener('click',e=>{if(e.target.id==='joinOverlay')closeOverlay('joinOverlay');});document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeGame();closeOverlay('inviteOverlay');closeOverlay('joinOverlay');}});
  const requestedRoomId=new URLSearchParams(location.search).get('room');
  onAuthStateChanged(auth,async user=>{
    currentUser=user;
    if(user){subscribeInvites();await loadContacts();if(requestedRoomId&&!activeRoomId)openRoom(requestedRoomId).catch(err=>{console.error(err);toast("Could not open the shared game room.","error");});}
    else{if(inviteUnsub)inviteUnsub();pendingInvites=[];renderInviteBanner();}
  });
}
window.addEventListener('DOMContentLoaded',boot);
