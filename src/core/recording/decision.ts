import { tempoCandidates, scoreInterpretation } from "./rhythm.js";
import type { RhythmHit, TimingCandidate } from "./rhythm.js";
import type { Transcript } from "../../services/transcription.js";
import type { JevAnswers, Instrument } from "../pattern/state.js";
export type RecordingEvidence = { transcript: Transcript; hits: RhythmHit[]; spans: { id: string; start_seconds: number; tempos: TimingCandidate[] }[] };
export type RecordingDecision = { mode: "add" | "replace" | "edit"; instrument: "automatic" | Instrument; span: string; timing: string };
export function prepareEvidence(transcript: Transcript, hits: RhythmHit[], currentTempo: number): RecordingEvidence {
  // Candidate boundaries, not speech removal: Whisper can transcribe "boom".
  const boundaries = [0];
  // Candidate generation only: Jev still chooses where the instruction ends.
  // A speaker need not pause between "like" and a vocalized drum syllable.
  const firstVocalization = transcript.words.findIndex(word => /^(boom|bum|kuh|kah|pah|buh|tss|tsh|psh|ts|pff|bmm)$/i.test(word.word.replace(/[^a-z ]/gi, "").trim()));
  if (firstVocalization > 0) boundaries.push(transcript.words[firstVocalization - 1].end);
  // Whisper may render the first demonstrated sound as "um" or omit the
  // remaining sounds. Offer the cue boundary independently of its spelling
  // or a required pause; Jev still decides whether this cue ends instruction.
  for (const word of transcript.words) {
    if (word.word.replace(/[^a-z]/gi, "").toLowerCase() === "like"
      && hits.some(hit => hit.onset_seconds >= word.start)) {
      // The final word can be stretched across several seconds of beatboxing.
      // Offer its start too, so its unreliable end cannot exclude the first hit.
      boundaries.push(word.start, word.end);
    }
  }
  transcript.words.forEach((word, i) => {
    const next = transcript.words[i + 1];
    if ((!next || next.start - word.end >= 0.2) && hits.some(hit => hit.onset_seconds >= word.end)) boundaries.push(word.end);
  });
  const starts = [...new Set(boundaries)].slice(0, 6);
  return { transcript, hits, spans: starts.map((start_seconds, index) => {
    const retained = hits.filter(hit => hit.onset_seconds >= start_seconds);
    const tempos = tempoCandidates(retained.map(hit => hit.onset_seconds), currentTempo)
      .map(tempo => ({ ...tempo, musical: scoreInterpretation(retained, tempo.tempo_bpm, tempo.grid_error) }))
      .sort((a, b) => b.musical.score - a.musical.score);
    return { id: `span_${index}`, start_seconds, tempos };
  }) };
}
const choice = (instructions: string, criteria: Record<string, unknown>) => ({ type: "choice" as const, instructions, criteria });
export function recordingQuestions(evidence: RecordingEvidence) {
  return {
    mode: choice("Given the spoken instruction and audio evidence, should this demonstration add to the pattern, replace it, or only edit existing notes? Never infer this intention from whether playback is running. Unqualified demonstrations with an empty pattern replace; with an existing pattern add unless speech asks to replace.", { add: "Add demonstrated hits while keeping existing notes.", replace: "Replace the entire pattern with this demonstration.", edit: "Speech asks to edit existing notes, without inserting this demonstration." }),
    instrument: choice("Does the instruction explicitly name an instrument for ALL demonstrated hits? Explicit instructions override local guesses; otherwise retain each hit's automatic guess. Vocalized syllables such as boom/kuh are demonstrations, NOT explicit instrument instructions. If the user says only give me a beat like boom kuh boom kuh, choose automatic, not kick.", { automatic: "Use the measured guesses, including mixed drums.", kick: "All kick.", snare: "All snare.", closed_hat: "All closed hi-hat.", open_hat: "All open hi-hat." }),
    span: choice("Which concrete start in `evidence.spans` separates the demonstration from the instruction? Keep vocalized hits such as transcribed boom, tss and pah. Whisper can mishear a demonstrated boom as um or omit later sounds. After a demonstration cue such as give me a beat like, do not discard that first sound merely because its transcript looks like a filler. Consider both boundaries around like: if its timestamp is stretched across measured drum hits, its end is unreliable and the earlier boundary may preserve the full demonstration. The selected span must keep the ENTIRE demonstration, including its first boom and following kuh sounds. Do not select a later repeated syllable merely because there is a pause before it. Compare preceding_words and remaining_words and retained_hits. best_interpretation includes soft musical preferences for a kick on beat one, repeated bars and a familiar interval across the loop boundary. Use them to break plausible ties, never to discard demonstrated hits or include spoken instructions. Use unresolved if none gives a clear boundary.", { ...Object.fromEntries(evidence.spans.map(span => [span.id, {
      start_seconds: span.start_seconds,
      preceding_words: evidence.transcript.words.filter(word => word.end <= span.start_seconds).map(word => word.word).join(" "),
      remaining_words: evidence.transcript.words.filter(word => word.end > span.start_seconds).map(word => word.word).join(" "),
      best_interpretation: span.tempos[0],
      retained_hits: evidence.hits.filter(hit => hit.onset_seconds >= span.start_seconds).length,
    }])), unresolved: "Boundary cannot be determined; ask user to adjust the start." }),
    timing: choice("Select a concrete tempo interpretation from `evidence.spans[].tempos`. Each option gives the scored interpretation for each possible span. The tempos are ranked locally by timing fit plus soft musical preferences. Prefer timing_0 unless the spoken instruction explicitly calls for another tempo interpretation; do not select current tempo simply because it is familiar. Non-repeating or snare-first performances are valid. Current playback tempo is preserved during playback or addition regardless of this selection.", Object.fromEntries([0, 1, 2, 3].filter(index => evidence.spans.some(span => span.tempos[index])).map(index => [`timing_${index}`, Object.fromEntries(evidence.spans.map(span => [span.id, (span.tempos[index] ?? span.tempos[0])]))]))),
  };
}
export function validateRecordingDecision(evidence: RecordingEvidence, answers: JevAnswers): RecordingDecision {
  const questions = recordingQuestions(evidence);
  const selected: Record<string, string> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (answer?.type !== "choice" || !Object.hasOwn(question.criteria, answer.choice)) throw new Error("Invalid recorded-rhythm decision.");
    selected[id] = answer.choice;
  }
  return selected as RecordingDecision;
}
export function validEvidence(value: unknown): value is RecordingEvidence {
  if (!value || typeof value !== "object") return false;
  const data = value as RecordingEvidence;
  if (!data.transcript || typeof data.transcript.text !== "string" || data.transcript.text.length > 5000 || !Array.isArray(data.transcript.words) || data.transcript.words.length > 500
    || !data.transcript.words.every(word => word && typeof word.word === "string" && word.word.length <= 200 && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start && word.end <= 30.1)
    || !Array.isArray(data.hits) || data.hits.length > 256 || !data.hits.every(hit => hit && Number.isFinite(hit.onset_seconds) && hit.onset_seconds >= 0 && hit.onset_seconds <= 30 && ["kick", "snare", "closed_hat"].includes(hit.instrument))
    || !Array.isArray(data.spans) || !data.spans.length || data.spans.length > 6) return false;
  return data.spans.every((span, index) => span?.id === `span_${index}` && Number.isFinite(span.start_seconds) && span.start_seconds >= 0 && span.start_seconds <= 30 && Array.isArray(span.tempos) && span.tempos.length > 0 && span.tempos.length <= 4 && span.tempos.every(t => t && Number.isFinite(t.tempo_bpm) && t.tempo_bpm >= 30 && t.tempo_bpm <= 360 && Number.isFinite(t.grid_error) && typeof t.uncertain === "boolean"));
}
