// CUNNACT dashboard v2 — additive UI wiring for the Stitch-style layout.
// Reads/observes existing DOM (built by app.js) and never redefines it.
(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(function () {
    var chatList = document.getElementById("chatList");
    var userSearch = document.getElementById("userSearch");
    var topbarSearch = document.getElementById("topbarSearchInput");
    var globalSearchBtn = document.getElementById("globalSearchBtn");
    var activeCountEl = document.getElementById("chatsActiveCount");
    var filterCountAll = document.getElementById("filterCountAll");
    var filterCountUnread = document.getElementById("filterCountUnread");
    var pills = Array.prototype.slice.call(document.querySelectorAll(".filter-pill"));
    var currentFilter = "all";

    // ---- Topbar search mirrors the sidebar chat search ----
    if (topbarSearch && userSearch) {
      topbarSearch.addEventListener("focus", function () {
        // Route typing into the real search box so results actually filter.
        userSearch.focus();
      });
      topbarSearch.addEventListener("input", function () {
        userSearch.value = topbarSearch.value;
        userSearch.dispatchEvent(new Event("input", { bubbles: true }));
      });
      userSearch.addEventListener("input", function () {
        if (document.activeElement !== topbarSearch) topbarSearch.value = userSearch.value;
      });
    }
    // ⌘K / Ctrl+K opens the full global search modal (already wired in app.js to globalSearchBtn).
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        globalSearchBtn?.click();
      }
    });
    topbarSearch?.addEventListener("click", function () {
      globalSearchBtn?.click();
    });

    // ---- Mirror the current user's avatar into the topbar ----
    var srcAvatar = document.getElementById("currentUserAvatar");
    var topbarAvatarWrap = document.getElementById("topbarUserAvatar");
    var topbarAccountBtn = document.getElementById("topbarAccountBtn");
    function syncTopbarAvatar() {
      if (!srcAvatar || !topbarAvatarWrap) return;
      var srcImg = srcAvatar.querySelector("img");
      var srcFallback = srcAvatar.querySelector(".avatar-fallback");
      var dstImg = topbarAvatarWrap.querySelector("img");
      var dstFallback = topbarAvatarWrap.querySelector(".avatar-fallback");
      if (srcImg && dstImg) {
        dstImg.src = srcImg.src;
        dstImg.hidden = srcImg.hidden;
      }
      if (srcFallback && dstFallback) {
        dstFallback.textContent = srcFallback.textContent;
        dstFallback.hidden = srcFallback.hidden;
        dstFallback.style.background = getComputedStyle(srcFallback).background;
      }
    }
    if (srcAvatar) {
      syncTopbarAvatar();
      new MutationObserver(syncTopbarAvatar).observe(srcAvatar, { childList: true, subtree: true, attributes: true });
    }
    topbarAccountBtn?.addEventListener("click", function () {
      document.getElementById("accountMenuBtn")?.click();
    });

    // ---- "Chats  N Active" + filter pills + pill counts ----
    function applyFilter() {
      if (!chatList) return;
      var items = chatList.querySelectorAll(".chat-item");
      var total = items.length, unread = 0;
      items.forEach(function (row) {
        var isUnread = !!row.querySelector(".unread-badge");
        var isGroup = !!row.querySelector(".group-badge");
        var isPinned = row.classList.contains("is-pinned");
        if (isUnread) unread++;
        var show = true;
        if (currentFilter === "unread") show = isUnread;
        else if (currentFilter === "groups") show = isGroup;
        else if (currentFilter === "pinned") show = isPinned;
        row.classList.toggle("filtered-out", !show);
      });
      if (activeCountEl) activeCountEl.textContent = total + (total === 1 ? " Active" : " Active");
      if (filterCountAll) filterCountAll.textContent = String(total);
      if (filterCountUnread) filterCountUnread.textContent = String(unread);
    }

    pills.forEach(function (pill) {
      pill.addEventListener("click", function () {
        currentFilter = pill.dataset.chatFilter || "all";
        pills.forEach(function (p) { p.classList.toggle("active", p === pill); });
        applyFilter();
      });
    });

    if (chatList) {
      applyFilter();
      new MutationObserver(applyFilter).observe(chatList, { childList: true, subtree: true });
    }
  });
})();
