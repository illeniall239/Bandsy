"""Local audio sidecar: speech-to-text (faster-whisper, CPU) and text-to-speech (Kokoro ONNX, CPU).

  python sidecar/audio.py            # http://localhost:3002
  POST /stt   body = audio file (webm/wav/m4a)         -> {"text", "duration", "segments":[{start,end,text}], "words":[{start,end,word}]}
  POST /tts   body = {"text", "voice"?}                -> audio/wav

Models load once at start (~10 s). Everything runs on CPU: whisper "base.en" int8 (accurate enough for band
scoring, fast enough for a 2-minute Part 2), Kokoro's British voices for the examiner.
"""
import io, json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

HERE = Path(__file__).parent
WHISPER = sys.argv[1] if len(sys.argv) > 1 else "base.en"   # ponytail: "small.en" if transcripts look sloppy; ~3x slower
t = time.time()
stt = WhisperModel(WHISPER, device="cpu", compute_type="int8")
tts = Kokoro(str(HERE / "models/kokoro-v1.0.onnx"), str(HERE / "models/voices-v1.0.bin"))
print(f"models ready in {time.time()-t:.0f}s (whisper {WHISPER})", flush=True)

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        t0 = time.time()
        try:
            if self.path == "/stt":
                segs, info = stt.transcribe(io.BytesIO(data), language="en", word_timestamps=True, vad_filter=True)
                segments, words = [], []
                for s in segs:
                    segments.append({"start": s.start, "end": s.end, "text": s.text.strip()})
                    words += [{"start": w.start, "end": w.end, "word": w.word.strip()} for w in (s.words or [])]
                out = {"text": " ".join(s["text"] for s in segments), "duration": info.duration, "segments": segments, "words": words, "ms": int((time.time() - t0) * 1000)}
                self._send(200, json.dumps(out).encode())
            elif self.path == "/tts":
                req = json.loads(data or b"{}")
                samples, rate = tts.create(req["text"], voice=req.get("voice", "bf_emma"), speed=req.get("speed", 1.0), lang="en-gb")
                buf = io.BytesIO(); sf.write(buf, samples, rate, format="WAV")
                self._send(200, buf.getvalue(), "audio/wav")
            else:
                self._send(404, b'{"error":"no such route"}')
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode())

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 3002), H).serve_forever()
