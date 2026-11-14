const STORAGE_KEY = "tally-board:counters";
const PALETTE = ["#6c8dff", "#ff6b6b", "#51cf66", "#ffd43b", "#c084fc", "#4ecdc4", "#ff922b", "#f783ac"];

/** @typedef {{id: string, name: string, value: number, step: number, color: string}} Counter */

/** @type {Counter[]} */
let counters = loadCounters();

const board = document.getElementById("board");
const emptyHint = document.getElementById("empty-hint");
const template = document.getElementById("counter-template");
const addBtn = document.getElementById("add-counter-btn");
const exportBtn = document.getElementById("export-btn");
const importInput = document.getElementById("import-input");

function loadCounters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCounters() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counters));
  } catch {
    // storage unavailable (private mode, quota) — fail silently
  }
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function createCounter(name = "New Counter") {
  const color = PALETTE[counters.length % PALETTE.length];
  const counter = { id: makeId(), name, value: 0, step: 1, color };
  counters.push(counter);
  saveCounters();
  renderBoard();
  const card = board.querySelector(`[data-id="${counter.id}"]`);
  card?.focus();
}

function deleteCounter(id) {
  const index = counters.findIndex((c) => c.id === id);
  if (index === -1) return;
  const [removed] = counters.splice(index, 1);
  saveCounters();
  renderBoard();
  showUndoToast(removed, index);
}

let undoTimeoutId = null;

function showUndoToast(counter, index) {
  clearTimeout(undoTimeoutId);
  const toast = document.getElementById("toast");
  toast.innerHTML = "";

  const message = document.createElement("span");
  message.textContent = `Deleted "${counter.name}".`;
  toast.appendChild(message);

  const undoBtn = document.createElement("button");
  undoBtn.textContent = "Undo";
  undoBtn.className = "toast-undo-btn";
  undoBtn.addEventListener("click", () => {
    counters.splice(index, 0, counter);
    saveCounters();
    renderBoard();
    hideToast();
  });
  toast.appendChild(undoBtn);

  toast.classList.add("visible");
  undoTimeoutId = setTimeout(hideToast, 5000);
}

function hideToast() {
  document.getElementById("toast").classList.remove("visible");
  clearTimeout(undoTimeoutId);
}

function updateCounter(id, patch) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  Object.assign(counter, patch);
  saveCounters();
}

function renderBoard() {
  board.innerHTML = "";
  emptyHint.style.display = counters.length === 0 ? "block" : "none";

  for (const counter of counters) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".counter");
    card.dataset.id = counter.id;
    card.style.setProperty("--counter-accent", counter.color || PALETTE[0]);
    card.draggable = true;

    const swatches = node.querySelector(".color-swatches");
    for (const color of PALETTE) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch" + (color === counter.color ? " selected" : "");
      swatch.style.background = color;
      swatch.title = "Set color";
      swatch.addEventListener("click", (e) => {
        e.stopPropagation();
        updateCounter(counter.id, { color });
        card.style.setProperty("--counter-accent", color);
        swatches.querySelectorAll(".swatch").forEach((s) => s.classList.remove("selected"));
        swatch.classList.add("selected");
      });
      swatches.appendChild(swatch);
    }

    card.addEventListener("dragstart", (e) => {
      if (e.target.closest("input, button")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/plain", counter.id);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    const nameInput = node.querySelector(".counter-name");
    nameInput.value = counter.name;
    nameInput.addEventListener("change", () => {
      updateCounter(counter.id, { name: nameInput.value.trim() || "Untitled" });
    });
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("keydown", (e) => e.stopPropagation());

    const valueEl = node.querySelector(".counter-value");
    valueEl.textContent = counter.value;

    const stepInput = node.querySelector(".step-input");
    stepInput.value = counter.step;
    stepInput.addEventListener("change", () => {
      const step = Math.max(1, parseInt(stepInput.value, 10) || 1);
      stepInput.value = step;
      updateCounter(counter.id, { step });
    });
    stepInput.addEventListener("click", (e) => e.stopPropagation());
    stepInput.addEventListener("keydown", (e) => e.stopPropagation());

    node.querySelector(".inc-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      bump(counter.id, valueEl, counter.step);
    });
    node.querySelector(".dec-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      bump(counter.id, valueEl, -counter.step);
    });
    node.querySelector(".reset-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      counter.value = 0;
      valueEl.textContent = 0;
      saveCounters();
    });
    node.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteCounter(counter.id);
    });

    card.addEventListener("keydown", (e) => {
      if (e.target !== card) return;
      if (e.key === "+" || e.key === "=" || e.key === "ArrowUp") {
        e.preventDefault();
        bump(counter.id, valueEl, counter.step);
      } else if (e.key === "-" || e.key === "ArrowDown") {
        e.preventDefault();
        bump(counter.id, valueEl, -counter.step);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteCounter(counter.id);
      } else if (e.key === "0") {
        e.preventDefault();
        counter.value = 0;
        valueEl.textContent = 0;
        saveCounters();
      }
    });

    board.appendChild(node);
  }
}

function bump(id, valueEl, delta) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  counter.value += delta;
  valueEl.textContent = counter.value;
  saveCounters();
}

function getDragAfterElement(container, x, y) {
  const cards = [...container.querySelectorAll(".counter:not(.dragging)")];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy);
      return distance < closest.distance ? { distance, element: child } : closest;
    },
    { distance: Infinity, element: null }
  ).element;
}

board.addEventListener("dragover", (e) => {
  const dragging = board.querySelector(".dragging");
  if (!dragging) return;
  e.preventDefault();
  const after = getDragAfterElement(board, e.clientX, e.clientY);
  if (!after || after === dragging) return;
  const rect = after.getBoundingClientRect();
  const insertAfter = e.clientX > rect.left + rect.width / 2;
  after.parentElement.insertBefore(dragging, insertAfter ? after.nextSibling : after);
});

board.addEventListener("drop", (e) => {
  e.preventDefault();
  const orderedIds = [...board.querySelectorAll(".counter")].map((el) => el.dataset.id);
  counters.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
  saveCounters();
});

function exportCounters() {
  const blob = new Blob([JSON.stringify(counters, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tally-board-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importCounters(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (!Array.isArray(data)) throw new Error("expected a JSON array of counters");
      const imported = data
        .filter((c) => c && typeof c.name === "string" && typeof c.value === "number")
        .map((c) => ({
          id: makeId(),
          name: c.name,
          value: c.value,
          step: Number.isFinite(c.step) && c.step > 0 ? c.step : 1,
          color: typeof c.color === "string" ? c.color : PALETTE[0],
        }));
      if (imported.length === 0) throw new Error("no valid counters found in file");
      counters = counters.concat(imported);
      saveCounters();
      renderBoard();
    } catch (err) {
      alert("Couldn't import file: " + err.message);
    }
  };
  reader.readAsText(file);
}

addBtn.addEventListener("click", () => createCounter());
exportBtn.addEventListener("click", () => exportCounters());
importInput.addEventListener("change", () => {
  const file = importInput.files?.[0];
  if (file) importCounters(file);
  importInput.value = "";
});

renderBoard();
