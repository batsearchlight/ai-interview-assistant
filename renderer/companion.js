/* global companionApi */

const stackEl = document.getElementById("stack");
const mainTextEl = document.getElementById("mainText");
const topicEl = document.getElementById("topic");
const confirmBar = document.getElementById("confirmBar");
const confirmText = document.getElementById("confirmText");

let maxHeight = 600;

// Fenster an den Inhalt anpassen — es waechst nach unten, scrollt aber nie.
// Passt der Inhalt nicht mehr auf den Bildschirm, fliegen die aeltesten
// Vertiefungs-Popups raus (die Haupt-Karte bleibt immer stehen).
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

companionApi.onNote((payload) => {
  if (payload.maxHeight) maxHeight = payload.maxHeight;

  if (payload.mode === "confirm") {
    confirmText.textContent = `Neues Thema erkannt: ${payload.topic}`;
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

// Follow-up-Buttons: kurz sperren, bis der neue Block eintrifft
for (const btn of document.querySelectorAll("#actions button")) {
  btn.addEventListener("click", () => {
    companionApi.followUp(btn.dataset.mode);
    for (const b of document.querySelectorAll("#actions button")) b.disabled = true;
    setTimeout(() => {
      for (const b of document.querySelectorAll("#actions button")) b.disabled = false;
    }, 4000);
  });
}
