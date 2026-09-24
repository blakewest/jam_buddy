import type { IncomingMessage, ServerResponse } from "node:http";
export type Transcript = { text: string; words: { word: string; start: number; end: number }[] };
export const MAX_WAV_BYTES = 44 + 192000 * 30 * 2;
export function validateWav(wav: Buffer): number {
  if (wav.length < 46 || wav.length > MAX_WAV_BYTES || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.toString("ascii", 12, 16) !== "fmt " || wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1
    || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 || wav.toString("ascii", 36, 40) !== "data"
    || wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2) throw new Error("Expected bounded mono PCM WAV.");
  const rate = wav.readUInt32LE(24);
  const duration = (wav.length - 44) / (2 * rate);
  if (rate < 8000 || rate > 192000 || wav.readUInt32LE(28) !== rate * 2 || wav.readUInt16LE(32) !== 2 || duration > 30) throw new Error("WAV must be at most 30 seconds at a supported sample rate.");
  return duration;
}
export async function transcribe(wav: Buffer, { apiKey, signal, fetchImpl = fetch }: { apiKey: string; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<Transcript> {
  const duration = validateWav(wav);
  signal.throwIfAborted();
  const response = await fetchImpl("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/whisper-1", input_audio: { data: wav.toString("base64"), format: "wav" }, response_format: "verbose_json", timestamp_granularities: ["word"], temperature: 0 }),
  });
  if (!response.ok) throw new Error(`OpenRouter transcription returned HTTP ${response.status}.`);
  const data = await response.json() as Transcript;
  signal.throwIfAborted();
  let previous = -1;
  if (!data || typeof data.text !== "string" || data.text.length > 5000 || !Array.isArray(data.words) || data.words.length > 500 || !data.words.every(word => {
    const valid = word && typeof word.word === "string" && word.word.length <= 200 && Number.isFinite(word.start) && Number.isFinite(word.end)
      && word.start >= 0 && word.start >= previous && word.end >= word.start && word.end <= duration + 0.1;
    previous = word?.start;
    return valid;
  }) || (data.text.trim() && !data.words.length)) throw new Error("Transcription returned invalid or missing word timestamps.");
  return { text: data.text, words: data.words.map(({ word, start, end }) => ({ word, start, end })) };
}

export async function handleTranscription(req: IncomingMessage, res: ServerResponse, apiKey: string | undefined, fetchImpl: typeof fetch) {
  const send = (status: number, error: string) => { if (!res.destroyed) res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error })); };
  if (req.headers["content-type"]?.split(";")[0] !== "audio/wav") return send(415, "WAV audio required.");
  if (Number(req.headers["content-length"]) > MAX_WAV_BYTES) return send(413, "Recording upload too large.");
  const abort = new AbortController();
  const timeout = setTimeout(() => { abort.abort(); send(504, "Transcription timed out. Retry this take."); }, 60000);
  const disconnect = () => { if (!res.writableEnded) abort.abort(); };
  res.on("close", disconnect);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      abort.signal.throwIfAborted();
      size += chunk.length;
      if (size > MAX_WAV_BYTES) return send(413, "Recording upload too large.");
      chunks.push(chunk);
    }
    const wav = Buffer.concat(chunks);
    try { validateWav(wav); } catch { return send(400, "Invalid WAV recording; maximum 30 seconds, mono PCM."); }
    if (!apiKey?.trim()) return send(503, "Set OPENROUTER_API_KEY in .env and restart the server.");
    const data = await transcribe(wav, { apiKey, fetchImpl, signal: abort.signal });
    if (!abort.signal.aborted && !res.destroyed) res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
  } catch (error) {
    if (!abort.signal.aborted) send(502, error instanceof Error ? error.message : "Transcription failed.");
  } finally { clearTimeout(timeout); res.off("close", disconnect); }
}
