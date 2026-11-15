"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type MicrophoneProblem = "blocked_by_frame" | "denied" | "no_device" | "unsupported";
export interface RecorderState {
  phase: "idle" | "starting" | "recording" | "paused" | "stopped";
  problem?: MicrophoneProblem;
  /** Milliseconds of sound recorded, pauses excluded. */
  elapsedMs: number;
  /** 0 to 1, for the level indicator. */
  level: number;
}
export interface RecordedChunk { index: number; durationMs: number; audio: Blob }

const MIN_CHUNK_MS = 20_000;
const MAX_CHUNK_MS = 30_000;
/** Below this level the microphone hears no speech. A chunk that never rises above it is not uploaded. */
const SILENCE = 0.012;
const MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** True when the page is embedded and the EHR did not allow the microphone for this frame. */
export function microphoneBlockedByFrame() {
  if (typeof document === "undefined") return false;
  const policy = (document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy;
  return window.self !== window.top && !!policy && !policy.allowsFeature("microphone");
}

/**
 * Records the visit as a series of short, independently playable parts (mono Opus, low bit rate).
 * A part ends at the first pause in speech after 20 seconds, or at 30 seconds at the latest, so
 * words are not cut and the end of the visit is quick. Silent parts are dropped.
 * Nothing is recorded until `start` is called, and the audio lives only in memory until it is uploaded.
 */
export function useRecorder(onChunk: (chunk: RecordedChunk) => void) {
  const [state, setState] = useState<RecorderState>({ phase: "idle", elapsedMs: 0, level: 0 });
  const refs = useRef<{
    stream?: MediaStream; recorder?: MediaRecorder; context?: AudioContext; analyser?: AnalyserNode; timer?: ReturnType<typeof setInterval>;
    index: number; chunkStarted: number; chunkActiveMs: number; totalMs: number; lastTick: number; heardSpeech: boolean; quietMs: number; mime: string; stopping: boolean; paused: boolean;
  }>({ index: 0, chunkStarted: 0, chunkActiveMs: 0, totalMs: 0, lastTick: 0, heardSpeech: false, quietMs: 0, mime: "", stopping: false, paused: false });
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  const beginPart = useCallback(() => {
    const r = refs.current;
    if (!r.stream) return;
    const recorder = new MediaRecorder(r.stream, { mimeType: r.mime || undefined, audioBitsPerSecond: 24_000 });
    const parts: Blob[] = [];
    const index = r.index++;
    r.chunkActiveMs = 0;
    r.heardSpeech = false;
    r.quietMs = 0;
    recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
    recorder.onstop = () => {
      const durationMs = recorder === r.recorder ? r.chunkActiveMs : (recorder as MediaRecorder & { activeMs?: number }).activeMs ?? 0;
      const heard = (recorder as MediaRecorder & { heard?: boolean }).heard ?? r.heardSpeech;
      // A silent part costs nothing: it is not sent.
      if (heard && durationMs >= 300 && parts.length) onChunkRef.current({ index, durationMs, audio: new Blob(parts, { type: recorder.mimeType || r.mime || "audio/webm" }) });
    };
    r.recorder = recorder;
    recorder.start();
  }, []);

  const cut = useCallback((restart: boolean) => {
    const r = refs.current;
    const recorder = r.recorder as (MediaRecorder & { activeMs?: number; heard?: boolean }) | undefined;
    if (!recorder || recorder.state === "inactive") return;
    recorder.activeMs = r.chunkActiveMs;
    recorder.heard = r.heardSpeech;
    recorder.stop();
    if (restart) beginPart();
  }, [beginPart]);

  const release = useCallback(() => {
    const r = refs.current;
    if (r.timer) clearInterval(r.timer);
    r.stream?.getTracks().forEach((track) => track.stop());
    void r.context?.close().catch(() => undefined);
    r.stream = undefined; r.context = undefined; r.analyser = undefined; r.timer = undefined;
  }, []);
  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setState((s) => ({ ...s, problem: "unsupported" })); return false; }
    if (microphoneBlockedByFrame()) { setState((s) => ({ ...s, problem: "blocked_by_frame" })); return false; }
    setState({ phase: "starting", elapsedMs: 0, level: 0 });
    const r = refs.current;
    try {
      r.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setState({ phase: "idle", elapsedMs: 0, level: 0, problem: name === "NotFoundError" ? "no_device" : window.self !== window.top ? "blocked_by_frame" : "denied" });
      return false;
    }
    r.mime = MIME.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
    r.index = 0; r.totalMs = 0; r.stopping = false; r.paused = false;
    r.context = new AudioContext();
    r.analyser = r.context.createAnalyser();
    r.analyser.fftSize = 1024;
    r.context.createMediaStreamSource(r.stream).connect(r.analyser);
    const samples = new Float32Array(r.analyser.fftSize);
    r.lastTick = performance.now();
    beginPart();
    r.timer = setInterval(() => {
      const now = performance.now();
      const delta = now - r.lastTick;
      r.lastTick = now;
      if (r.paused || !r.analyser) return;
      r.analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      r.chunkActiveMs += delta;
      r.totalMs += delta;
      if (level > SILENCE) { r.heardSpeech = true; r.quietMs = 0; } else r.quietMs += delta;
      // End the part at a pause in speech once it is long enough, or at the hard limit.
      if (r.chunkActiveMs >= MAX_CHUNK_MS || (r.chunkActiveMs >= MIN_CHUNK_MS && r.quietMs >= 350)) cut(true);
      setState((s) => ({ ...s, elapsedMs: r.totalMs, level: Math.min(1, level * 8) }));
    }, 100);
    setState({ phase: "recording", elapsedMs: 0, level: 0 });
    return true;
  }, [beginPart, cut]);

  const pause = useCallback(() => {
    const r = refs.current;
    if (r.recorder?.state === "recording") { r.recorder.pause(); r.paused = true; setState((s) => ({ ...s, phase: "paused", level: 0 })); }
  }, []);
  const resume = useCallback(() => {
    const r = refs.current;
    if (r.recorder?.state === "paused") { r.recorder.resume(); r.paused = false; r.lastTick = performance.now(); setState((s) => ({ ...s, phase: "recording" })); }
  }, []);
  /** Ends the recording, hands over the last part and releases the microphone. */
  const stop = useCallback(() => {
    cut(false);
    release();
    setState((s) => ({ ...s, phase: "stopped", level: 0 }));
  }, [cut, release]);

  return { state, start, pause, resume, stop };
}
