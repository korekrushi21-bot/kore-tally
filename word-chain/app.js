const STORAGE_KEY = "word-chain:best-score";

const startScreen = document.getElementById("start-screen");
const gameScreen = document.getElementById("game-screen");
const endScreen = document.getElementById("end-screen");

const startBtn = document.getElementById("start-btn");
const restartBtn = document.getElementById("restart-btn");

const wordForm = document.getElementById("word-form");
const wordInput = document.getElementById("word-input");
const feedback = document.getElementById("feedback");
const chainTrail = document.getElementById("chain-trail");
const nextLetterEl = document.getElementById("next-letter");
const timerFill = document.getElementById("timer-fill");

const scoreEl = document.getElementById("score");
const bestScoreEl = document.getElementById("best-score");
const streakEl = document.getElementById("streak");
const finalScoreEl = document.getElementById("final-score");
const endTitle = document.getElementById("end-title");
const newBestEl = document.getElementById("new-best");

let best = Number(localStorage.getItem(STORAGE_KEY)) || 0;
let chain = [];
let usedWords = new Set();
let score = 0;
let streak = 0;
let timeLimit = 12;
let remaining = 12;
let playing = false;
let rafId = null;
let lastFrame = null;

bestScoreEl.textContent = best;

function showScreen(name) {
  startScreen.classList.toggle("hidden", name !== "start");
  gameScreen.classList.toggle("hidden", name !== "game");
  endScreen.classList.toggle("hidden", name !== "end");
}

function pickStartWord() {
  const candidates = WORD_LIST.filter((w) => w.length >= 4 && w.length <= 8);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function startGame() {
  chain = [pickStartWord()];
  usedWords = new Set(chain);
  score = 0;
  streak = 0;
  timeLimit = 12;
  remaining = timeLimit;
  playing = true;

  updateStats();
  renderChain();
  feedback.textContent = "";
  feedback.className = "";
  wordInput.value = "";
  showScreen("game");
  wordInput.focus();

  lastFrame = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function tick(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  remaining -= dt;

  if (remaining <= 0) {
    remaining = 0;
    updateTimerBar();
    endGame("Time's up!");
    return;
  }

  updateTimerBar();
  rafId = requestAnimationFrame(tick);
}

function updateTimerBar() {
  const pct = Math.max(0, (remaining / timeLimit) * 100);
  timerFill.style.width = pct + "%";
  timerFill.style.background = pct < 25 ? "var(--danger)" : pct < 50 ? "var(--warn)" : "var(--accent)";
}

function endGame(reason) {
  playing = false;
  cancelAnimationFrame(rafId);
  endTitle.textContent = reason;
  finalScoreEl.textContent = score;

  if (score > best) {
    best = score;
    localStorage.setItem(STORAGE_KEY, String(best));
    newBestEl.classList.remove("hidden");
  } else {
    newBestEl.classList.add("hidden");
  }
  bestScoreEl.textContent = best;
  showScreen("end");
}

function updateNextLetterHint() {
  const last = chain[chain.length - 1];
  nextLetterEl.textContent = last[last.length - 1].toUpperCase();
}

function renderChain() {
  chainTrail.innerHTML = "";
  for (const w of chain) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = w;
    chainTrail.appendChild(chip);
  }
  chainTrail.scrollLeft = chainTrail.scrollWidth;
  updateNextLetterHint();
}

function updateStats() {
  scoreEl.textContent = score;
  streakEl.textContent = streak;
  bestScoreEl.textContent = best;
}

function showFeedback(message, isError) {
  feedback.textContent = message;
  feedback.className = isError ? "error" : "success";
}

function penalize() {
  remaining = Math.max(0.5, remaining - 2);
  wordInput.classList.remove("shake");
  // force reflow so the animation can replay
  void wordInput.offsetWidth;
  wordInput.classList.add("shake");
}

wordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!playing) return;

  const raw = wordInput.value.trim().toLowerCase();
  wordInput.value = "";
  if (!raw) return;

  const lastWord = chain[chain.length - 1];
  const requiredLetter = lastWord[lastWord.length - 1];

  if (!/^[a-z]+$/.test(raw)) {
    showFeedback("Letters only.", true);
    penalize();
    return;
  }
  if (raw[0] !== requiredLetter) {
    showFeedback(`Must start with "${requiredLetter.toUpperCase()}".`, true);
    penalize();
    return;
  }
  if (usedWords.has(raw)) {
    showFeedback("Already used that word.", true);
    penalize();
    return;
  }
  if (!DICTIONARY.has(raw)) {
    showFeedback("Not in the word list.", true);
    penalize();
    return;
  }

  chain.push(raw);
  usedWords.add(raw);
  streak += 1;
  score += 10 + raw.length;
  timeLimit = Math.max(5, 12 - Math.floor(streak / 5));
  remaining = timeLimit;

  showFeedback("Nice!", false);
  updateStats();
  renderChain();
});

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", startGame);

showScreen("start");
