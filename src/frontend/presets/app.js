import { AUDITION_GROOVES } from "/core/pattern/audition-grooves.js";

const storageKey = "jam-partner-preset-curation";
const list = document.querySelector("#preset-list");
const styleFilter = document.querySelector("#style-filter");
const resultCount = document.querySelector("#result-count");
let decisions = {};

try { decisions = JSON.parse(localStorage.getItem(storageKey)) ?? {}; } catch { decisions = {}; }

function save(id, decision) {
  if (decision) decisions[id] = decision;
  else delete decisions[id];
  localStorage.setItem(storageKey, JSON.stringify(decisions));
  render();
}

const genres = [...new Set(AUDITION_GROOVES.map(groove => groove.style.split("/")[0]))].sort();
for (const genre of genres) styleFilter.add(new Option(genre, genre));
styleFilter.addEventListener("change", render);

function render() {
  const grooves = AUDITION_GROOVES.filter(groove => !styleFilter.value || groove.style.split("/")[0] === styleFilter.value);
  resultCount.textContent = `${grooves.length} grooves`;
  list.replaceChildren(...grooves.map(groove => {
    const article = document.createElement("article");
    const bars = groove.source_bars;
    const title = groove.style.split("/").map(part => part.replace(/\b\w/g, letter => letter.toUpperCase())).join(" · ");
    article.innerHTML = `
      <div class="title-row"><h2>${title}</h2><span>${groove.bars} bars</span></div>
      <p class="meta">${groove.meter} · ${groove.bpm} BPM · ${groove.drummer} · source bars ${bars[0]}–${bars[1]}</p>
      <button class="preview">Play preview</button>
      <audio controls preload="none" hidden></audio>
      <div class="actions">
        <button data-choice="keep" aria-pressed="${decisions[groove.id] === "keep"}">Keep</button>
        <button data-choice="reject" aria-pressed="${decisions[groove.id] === "reject"}">Reject</button>
        <button data-choice="">Clear</button>
      </div>`;
    for (const button of article.querySelectorAll(".actions button")) button.addEventListener("click", () => save(groove.id, button.dataset.choice));
    const audio = article.querySelector("audio");
    article.querySelector(".preview").addEventListener("click", event => {
      audio.src = groove.audio_url;
      audio.hidden = false;
      event.currentTarget.hidden = true;
      audio.play();
    });
    audio.addEventListener("play", event => {
      for (const audio of document.querySelectorAll("audio")) if (audio !== event.currentTarget) audio.pause();
    });
    return article;
  }));
}

render();
