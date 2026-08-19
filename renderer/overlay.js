/* global overlayApi */

const rectEl = document.getElementById("rect");
let startX = 0;
let startY = 0;
let dragging = false;

function currentRect(e) {
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const width = Math.abs(e.clientX - startX);
  const height = Math.abs(e.clientY - startY);
  return { x, y, width, height };
}

document.addEventListener("mousedown", (e) => {
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  rectEl.style.display = "block";
});

document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const r = currentRect(e);
  rectEl.style.left = r.x + "px";
  rectEl.style.top = r.y + "px";
  rectEl.style.width = r.width + "px";
  rectEl.style.height = r.height + "px";
});

document.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  overlayApi.done(currentRect(e));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") overlayApi.done(null);
});
