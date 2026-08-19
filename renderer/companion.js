/* global companionApi */

const stackEl = document.getElementById("stack");
const mainTextEl = document.getElementById("mainText");
const topicEl = document.getElementById("topic");
const confirmBar = document.getElementById("confirmBar");
const confirmText = document.getElementById("confirmText");

let maxHeight = 600;

// Fit the window to its content — it grows downwards but never scrolls.
// When the content no longer fits on the screen, the oldest follow-up
// popups are dropped (the main card always stays).
function syncHeight() {
  requestAnimationFrame(() => {
    let deepPops = stackEl.querySelectorAll(".pop.deep");
    while (stackEl.scrollHeight > maxHeight && deepPops.length > 1) {
      deepPops[0].remove();
      deepPops = stackEl.querySelectorAll(".pop.deep");
    }
    companionApi.resize(Math.min(stackEl.scrollHeight + 4, maxHeight));
  });
}

function addDeepPop(tag, text) {
  const pop = document.createElement("div");
  pop.className = "pop deep";
  if (tag) {
    const t = document.createElement("span");
    t.className = "btag";
    t.textContent = tag;
    pop.appendChild(t);
  }
  const body = document.createElement("span");
  body.className = "ptext";
  body.textContent = text;
  pop.appendChild(body);
  stackEl.appendChild(pop);
  syncHeight();
}

function clearDeepPops() {
  for (const p of stackEl.querySelectorAll(".pop.deep")) p.remove();
}

function hideConfirm() {
  confirmBar.classList.remove("visible");
}

// Conversation thread: blocks are appended and stay in place. A complete
// topic change replaces the thread — in confirmation mode only after
// clicking "Switch".
companionApi.onNote((payload) => {
  if (payload.maxHeight) maxHeight = payload.maxHeight;

  if (payload.mode === "confirm") {
    confirmText.textContent = `New topic detected: ${payload.topic}`;
    confirmBar.classList.add("visible");
    syncHeight();
    return;
  }

  hideConfirm();
  if (payload.mode === "reset") {
    clearDeepPops();
    topicEl.textContent = payload.topic ? `📌 ${payload.topic}` : "";
    mainTextEl.textContent = payload.text;
  } else {
    addDeepPop(payload.tag || null, payload.text);
  }
  syncHeight();
});

document.getElementById("btnTopicYes").addEventListener("click", () => {
  hideConfirm();
  companionApi.topicConfirm(true);
  syncHeight();
});

document.getElementById("btnTopicNo").addEventListener("click", () => {
  hideConfirm();
  companionApi.topicConfirm(false);
  syncHeight();
});

document.getElementById("btnClose").addEventListener("click", () => {
  companionApi.hide();
});

// follow-up buttons: briefly disable until the new block arrives
for (const btn of document.querySelectorAll("#actions button")) {
  btn.addEventListener("click", () => {
    companionApi.followUp(btn.dataset.mode);
    for (const b of document.querySelectorAll("#actions button")) b.disabled = true;
    setTimeout(() => {
      for (const b of document.querySelectorAll("#actions button")) b.disabled = false;
    }, 4000);
  });
}
