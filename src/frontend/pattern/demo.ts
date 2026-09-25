import { DemoJournal, DemoTimeline, bytesToBase64, base64ToBytes, parseDemo, MAX_DEMO_MS, MAX_DEMO_BYTES } from "../../core/demo/recording.js";
import type { DemoRecording, DemoView, DemoTake, DemoCall, EmbeddedAudio } from "../../core/demo/recording.js";
import type { Instrument } from "../../core/pattern/state.js";

async function storeDemo(key: "saved" | "draft", value?: DemoRecording): Promise<DemoRecording | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("jam-partner-demos", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("recordings");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("recordings", value ? "readwrite" : "readonly");
      const store = tx.objectStore("recordings");
      const request = value ? store.put(value, key) : store.get(key);
      if (value && key === "saved") store.delete("draft");
      tx.oncomplete = () => resolve(value ? undefined : request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const embedded = async (blob: Blob): Promise<EmbeddedAudio> => ({ mime_type: blob.type, base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });

export function createDemoStudio(options: {
  authoring?: boolean;
  context: () => Promise<AudioContext>;
  connectOutput: (destination: AudioNode) => () => void;
  view: () => DemoView;
  onChange: () => void;
  onReplayView: (view: DemoView) => void;
  onReplayHit: (instrument: Instrument) => void;
  onReplayEnd: (completed: boolean, finalView?: DemoView) => void;
}) {
  let saved: DemoRecording | undefined;
  let journal: DemoJournal | undefined;
  let recorder: MediaRecorder | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let silence: ConstantSourceNode | undefined;
  let disconnect: (() => void) | undefined;
  let chunks: Blob[] = [];
  let checkpoint = Promise.resolve();
  let busy = false;
  let replaying = false;
  let replayVersion = 0;
  let audio: HTMLAudioElement | undefined;
  let audioUrl: string | undefined;
  let animation = 0;
  let clock: ReturnType<typeof setInterval> | undefined;
  let replayPosition = 0;
  let caption = "";
  let message = "Record your commands and beat, then replay the saved performance.";
  let finishing: Promise<void> | undefined;
  const now = () => performance.now();
  const elapsed = () => journal ? journal.elapsed(now()) : replayPosition;
  const changed = () => options.onChange();
  const storageWarning = () => { message = "Local autosave failed. Finish and download your demo to keep it."; changed(); };

  function recordView() {
    if (!journal || busy) return;
    try { journal.view(options.view(), now()); }
    catch (error) { message = String(error); void finish(false); }
  }
  function recordHit(instrument: Instrument) {
    if (!journal || busy) return;
    try { journal.hit(instrument, now()); } catch (error) { message = String(error); void finish(false); }
  }
  function recordTake(take: DemoTake) {
    if (!journal) return;
    try { journal.take(take); } catch (error) { message = String(error); void finish(false); }
  }
  function recordCall(call: DemoCall) {
    if (!journal) return;
    try { journal.call(call); } catch (error) { message = String(error); void finish(false); }
  }
  function cleanupCapture() {
    clearInterval(clock);
    disconnect?.(); disconnect = undefined;
    silence?.stop(); silence?.disconnect(); silence = undefined;
    destination?.stream.getTracks().forEach(track => track.stop());
    destination = undefined;
  }
  function queueCheckpoint() {
    if (!journal || !chunks.length) return;
    const active = journal;
    const durationAt = now();
    const blob = new Blob(chunks, { type: recorder!.mimeType });
    // Snapshot now; later commands must not be paired with earlier audio.
    const snapshot = active.finish({ mime_type: blob.type, base64: "" }, durationAt);
    checkpoint = checkpoint.then(async () => {
      snapshot.audio = await embedded(blob);
      await storeDemo("draft", snapshot);
    }).catch(storageWarning);
  }
  async function start() {
    if (!options.authoring || journal || busy || replaying) return;
    busy = true; changed();
    try {
      if (typeof MediaRecorder === "undefined") throw new Error("Demo recording is not supported in this browser.");
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error("This browser cannot record demo audio. Try Chrome or Edge.");
      const context = await options.context();
      destination = context.createMediaStreamDestination();
      // Keep producing audio frames when the beat and microphone are silent.
      // Otherwise some browsers leave timestamp gaps in the recorded stream.
      silence = context.createConstantSource();
      silence.offset.value = 0;
      silence.connect(destination);
      silence.start();
      disconnect = options.connectOutput(destination);
      chunks = [];
      recorder = new MediaRecorder(destination.stream, { mimeType: mime, audioBitsPerSecond: 160000 });
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
        if (!busy) queueCheckpoint();
      };
      await new Promise<void>((resolve, reject) => {
        recorder!.onstart = () => resolve();
        recorder!.onerror = () => reject(new Error("Could not start demo audio recording."));
        recorder!.start(5000);
      });
      journal = new DemoJournal(options.view(), now());
      recorder.onerror = () => { message = "Audio recording was interrupted. Saving what was captured."; void finish(false); };
      message = "Recording demo · Use Hold to speak as usual. Finish when you’re done.";
      clock = setInterval(() => {
        recordView(); changed();
        if (elapsed() >= MAX_DEMO_MS) { message = "Ten-minute demo limit reached."; void finish(false); }
      }, 500);
    } catch (error) {
      cleanupCapture();
      message = error instanceof Error ? error.message : String(error);
    } finally { busy = false; changed(); }
  }
  async function finish(captureLastView = true) {
    if (finishing) return finishing;
    if (!journal || !recorder) return;
    if (captureLastView) recordView();
    if (finishing) return finishing;
    busy = true; changed();
    const active = journal;
    const recording = recorder;
    finishing = (async () => {
      try {
        await new Promise<void>(resolve => {
          recording.onstop = () => resolve();
          if (recording.state === "inactive") resolve(); else recording.stop();
        });
        const finishedAt = now();
        cleanupCapture();
        const mix = await embedded(new Blob(chunks, { type: recording.mimeType }));
        if (!mix.base64) throw new Error("No demo audio was captured. Try recording again.");
        saved = active.finish(mix, finishedAt);
        await checkpoint;
        try { await storeDemo("saved", saved); message = "Demo saved locally. Play it back or download a copy."; }
        catch { message = "Demo ready, but local autosave failed. Download it to keep a copy."; }
      } catch (error) { message = error instanceof Error ? error.message : String(error); }
      finally {
        cleanupCapture(); journal = undefined; recorder = undefined; chunks = [];
        busy = false; finishing = undefined; changed();
      }
    })();
    return finishing;
  }
  function stopReplay(completed = false) {
    if (!replaying) return;
    replayVersion++;
    cancelAnimationFrame(animation);
    if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); audio.removeAttribute("src"); audio.load(); }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audio = undefined; audioUrl = undefined; replaying = false; busy = false; caption = "";
    options.onReplayEnd(completed, completed && saved ? structuredClone(saved.frames.at(-1)!.view) : undefined); changed();
  }
  async function play() {
    if (!saved || journal || busy || replaying) return;
    replaying = true; busy = true; replayPosition = 0; changed();
    const version = ++replayVersion;
    try {
      const timeline = new DemoTimeline(saved);
      const blob = new Blob([base64ToBytes(saved.audio.base64)], { type: saved.audio.mime_type });
      audioUrl = URL.createObjectURL(blob);
      const playback = new Audio(audioUrl);
      audio = playback;
      playback.onended = () => { message = "Demo finished. Your working beat is ready."; stopReplay(true); };
      playback.onerror = () => { message = "This browser could not play the saved audio. Try the browser that recorded it."; stopReplay(); };
      let lastView: DemoView | undefined;
      let lastProgress = -Infinity;
      const tick = () => {
        if (!replaying || version !== replayVersion) return;
        replayPosition = playback.currentTime * 1000;
        const current = timeline.advance(replayPosition);
        if (current.view !== lastView) { lastView = current.view; options.onReplayView(current.view); }
        for (const instrument of current.hits) options.onReplayHit(instrument);
        caption = current.caption;
        if (replayPosition - lastProgress >= 100) { lastProgress = replayPosition; changed(); }
        animation = requestAnimationFrame(tick);
      };
      options.onReplayView(saved.frames[0].view);
      await playback.play();
      if (version !== replayVersion) return;
      busy = false; message = "Playing saved demo · Voice, beat, and actions"; tick();
    } catch (error) {
      if (version === replayVersion) { message = error instanceof Error ? error.message : String(error); stopReplay(); }
    }
  }
  async function loadFile(file: File) {
    if (!options.authoring || journal || busy || replaying) return;
    busy = true; changed();
    try {
      if (file.size > MAX_DEMO_BYTES) throw new Error("Demo files must be smaller than 128 MB.");
      const next = parseDemo(await file.text());
      saved = next;
      try { await storeDemo("saved", next); message = "Demo loaded. Ready to play."; } catch { storageWarning(); }
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; changed(); }
  }
  function download() {
    if (!options.authoring || !saved) return;
    const blob = new Blob([JSON.stringify(saved)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `jev-demo-${saved.created_at.slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore() {
    busy = true; changed();
    try {
      const [draft, completed] = options.authoring ? await Promise.all([storeDemo("draft"), storeDemo("saved")]) : [];
      const candidate = draft ?? completed;
      if (candidate) {
        saved = parseDemo(JSON.stringify(candidate));
        message = draft ? "Recovered an unfinished demo from local autosave. Play or download it." : "Saved demo ready to play.";
      } else {
        const response = await fetch("/assets/demo/featured.json");
        if (!response.ok) throw new Error("The featured demo could not be loaded.");
        saved = parseDemo(await response.text());
        message = "Play Blake’s demo · Voice, beat, and Jev’s actions";
      }
    } catch (error) { message = error instanceof Error ? `Could not restore demo: ${error.message}` : "Demo storage is unavailable. You can still record and download."; }
    busy = false; changed();
  }
  return {
    start, finish, play, stopReplay, loadFile, download, restore, recordView, recordHit, recordTake, recordCall,
    microphoneDestination: () => journal ? destination : undefined,
    elapsed, isRecording: () => !!journal, isReplaying: () => replaying, isBusy: () => busy,
    hasSaved: () => !!saved, message: () => message, caption: () => caption,
    duration: () => saved?.duration_ms ?? 0,
  };
}
