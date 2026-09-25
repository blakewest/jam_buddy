import { INSTRUMENTS } from "../../core/pattern/state.js";
import type { Pattern } from "../../core/pattern/state.js";
import { selectionFromCells, selectionRegions, validSelection } from "../../core/pattern/selection.js";
import type { BeatSelection } from "../../core/pattern/selection.js";

type Cell = { lane: number; beat: number };
export function createGridSelection(grid: HTMLElement, summary: HTMLElement, clear: HTMLButtonElement, pattern: () => Pattern, locked: () => boolean, onChange = () => {}) {
  let selected: BeatSelection | null = null;
  let anchor: Cell | null = null;
  let cursor: Cell = { lane: 0, beat: 0 };
  let dragging = false;
  let previous: BeatSelection | null = null;
  function refresh() {
    if (selected && !validSelection(selected, pattern())) selected = null;
    grid.querySelectorAll(".selection-overlay").forEach(el => el.remove());
    if (selected) {
      for (const instrument of selected.instruments) {
        const track = grid.querySelector(`.lane-${instrument} .lane-track`);
        if (!track) continue;
        const highlight = document.createElement("span");
        highlight.className = "selection-overlay";
        highlight.style.left = `${selected.start_beat / (pattern().bars * selected.beats_per_bar) * 100}%`;
        highlight.style.width = `${(selected.end_beat - selected.start_beat) / (pattern().bars * selected.beats_per_bar) * 100}%`;
        track.append(highlight);
      }
      const lanes = selected.instruments.map(i => i.replaceAll("_", " ")).join(", ");
      const regions = selectionRegions(selected).map(r => `bar ${r.bar}, beat${r.beats.length > 1 ? "s" : ""} ${r.beats.length === 1 ? r.beats[0] : `${r.beats[0]}–${r.beats.at(-1)}`}`).join(" · ");
      summary.textContent = `${lanes} · ${regions}`;
    } else summary.textContent = "Drag across the grid to select a section";
    clear.hidden = !selected;
    clear.disabled = locked();
    summary.parentElement?.classList.toggle("has-selection", !!selected);
    grid.setAttribute("aria-label", selected ? `Selected ${summary.textContent}. Arrow keys move; Shift and arrows extend; Escape clears.` : "Drum pattern. Drag to select, or use arrow keys; Shift and arrows extend.");
  }
  function reset() { selected = null; anchor = null; dragging = false; refresh(); onChange(); }
  function cellAt(event: PointerEvent): Cell | null {
    const rows = [...grid.querySelectorAll<HTMLElement>(".pattern-lane")];
    const track = rows[0]?.querySelector(".lane-track")?.getBoundingClientRect();
    if (!track || !rows.length) return null;
    const lane = rows.findIndex(row => event.clientY < row.getBoundingClientRect().bottom);
    const beat = Math.floor((event.clientX - track.left) / track.width * pattern().bars * pattern().meter.numerator);
    return { lane: lane < 0 ? rows.length - 1 : lane, beat: Math.max(0, Math.min(pattern().bars * pattern().meter.numerator - 1, beat)) };
  }
  function select(cell: Cell) {
    cursor = cell;
    selected = selectionFromCells(anchor ?? cell, cell, pattern().meter.numerator);
    refresh();
    onChange();
  }
  grid.addEventListener("pointerdown", event => {
    if (event.button !== 0 || locked() || !(event.target instanceof Element) || !event.target.closest(".lane-track")) return;
    const cell = cellAt(event);
    if (!cell) return;
    event.preventDefault();
    previous = selected;
    anchor = cell;
    dragging = true;
    grid.focus({ preventScroll: true });
    grid.setPointerCapture(event.pointerId);
    select(cell);
  });
  grid.addEventListener("pointermove", event => {
    if (!dragging || locked()) return;
    const cell = cellAt(event);
    if (cell) select(cell);
  });
  grid.addEventListener("pointerup", () => { dragging = false; });
  grid.addEventListener("pointercancel", () => { dragging = false; selected = previous; refresh(); onChange(); });
  grid.addEventListener("lostpointercapture", () => { dragging = false; });
  grid.addEventListener("keydown", event => {
    if (locked()) return;
    if (event.key === "Escape") { event.preventDefault(); reset(); return; }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const next = {
      lane: Math.max(0, Math.min(INSTRUMENTS.length - 1, cursor.lane + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0))),
      beat: Math.max(0, Math.min(pattern().bars * pattern().meter.numerator - 1, cursor.beat + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0))),
    };
    if (!event.shiftKey || !anchor) anchor = next;
    select(next);
  });
  clear.addEventListener("click", () => { if (!locked()) reset(); });
  return { refresh, clear: reset, set: (value: BeatSelection | null) => { selected = value ? structuredClone(value) : null; anchor = null; refresh(); }, snapshot: () => selected ? structuredClone(selected) : null };
}
