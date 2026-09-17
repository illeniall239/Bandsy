# Bandsy

A personal IELTS Academic prep app covering all four modules, built on the Cambridge IELTS 10 to 15 practice tests (24 tests). It runs on your own computer. Reading and Listening look like the computer-delivered exam, and a model you choose grades Writing and Speaking.

## What it does

- **Home.** One session a day, the countdown to your exam date, your latest band per module, and a band-over-time chart. It starts with a diagnostic (one full mock per module), then moves to a weekly rotation weighted towards your weakest module.
- **Tests.** Every test, module by module. **Mock** is the full module under exam conditions and gives you a band. **Drill** is one part, passage or task, untimed.
- **Listening.** Real book audio (played once in a mock), question types as in the book, number flags and a review strip. Results mark each answer and can show the transcript with each speaker's turns.
- **Reading.** Passage and questions side by side, highlighting and notes. Double-click a word to save it to your word bank.
- **Explain.** On any Listening or Reading result, "Explain" quotes where the answer is in the transcript or passage, why the key is right, why your answer didn't fit, and gives a tip. Explanations are cached.
- **Writing.** Tasks 1 and 2 with a word count. Grading gives the four criteria bands and marks the errors inline.
- **Speaking.** A three-part test with a spoken examiner, or a tutor mode that replies as you go. Speech-to-text and the examiner's voice run locally; a model handles Part 3 follow-ups and feedback.
- **Vocabulary.** Your saved words with definitions, plus topic word lists from *Check Your English Vocabulary for IELTS*.
- **Settings.** API keys per provider and one model per job (Writing grading, Speaking, small tasks). Nothing is chosen for you: a job without a model refuses to run.

## How it is built

| Part | What it is |
| --- | --- |
| `src/` | React single-page app (Vite). |
| `server.js` | One Node process: serves the built app, `content/` and the audio, plus a small JSON API over SQLite (`bandsy.db`). |
| `providers.js` | Model providers: Claude through Claude Code (your subscription, no API key), OpenAI, Groq, Gemini, Ollama, and any OpenAI-compatible endpoint. |
| `grading.js`, `examiner.js`, `explain.js`, `review.js`, `plan.js` | Writing grading, the Speaking examiner, Explain, the word bank, and the daily plan. |
| `src/mark.js` | Marks Listening and Reading answers the IELTS way (alternatives, optional words, "in either order" pairs). |
| `sidecar/audio.py` | Local speech service on port 3002: faster-whisper for speech-to-text, Kokoro for the examiner's voice. |
| `content/` | The extracted tests: `camNN/testN.json` plus figures, and `vocab.json`. |
| `pipeline/` | The scripts that turn the book PDFs and audio into `content/`. |
| `deploy/` | Scripts for running a hosted copy on a server. |

## Requirements

- Node.js 22
- Python 3.11 with `faster-whisper`, `kokoro-onnx` and `soundfile` (for Speaking)
- The Kokoro model files `kokoro-v1.0.onnx` and `voices-v1.0.bin` in `sidecar/models/` (from the [kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases))
- The Cambridge IELTS books folder at `Cambridge-lists-main/`. The app plays the Listening audio from there, so it isn't in this repo.
- At least one model provider: Claude Code signed in, an API key, or Ollama running locally

## Running it

```
npm install
pip install faster-whisper kokoro-onnx soundfile
npm run dev
```

Open http://localhost:5173. `npm run dev` starts the API on port 3001, the Vite dev server, and the speech sidecar.

Then go to **Settings**, add a key (or use Claude Code or Ollama), and pick a model for each job.

Other commands:

- `npm run build`, then `npm start`: serve the built app from http://localhost:3001
- `node server.js --no-sidecar`: run without Speaking
- `npm test`: marking self-check
- `node plan.js`: daily plan self-check

## Your data

Everything you do is stored in `bandsy.db` in the project folder: attempts, answers, bands, saved words, settings and API keys. It is not in the repo. Back it up by copying the file.

For test runs, point the server at a scratch database so your real history is never touched:

```
BANDSY_DB=work/test.db PORT=3011 node server.js --no-sidecar
```

## Content pipeline

`content/` is produced from the book PDFs and audio by `pipeline/extract.py`. The text comes from OCR. A model is used only where OCR can't do the job: structuring question groups, reading answer keys, and fixing garbled pages, titles and option lists. Every step is cached under `work/camNN/`, so re-running costs nothing.

Extra requirements: Tesseract OCR, `pymupdf`, and `faster-whisper` (used to repair transcripts against the recordings).

```
python pipeline/extract.py ocr       --book 15
python pipeline/extract.py map       --book 15
python pipeline/extract.py units     --book 15 --text claude:sonnet --vision claude:sonnet
python pipeline/extract.py scripts   --book 15
python pipeline/extract.py proofread --book 15 --text claude:sonnet
python pipeline/extract.py turns     --book 15 --text claude:sonnet
python pipeline/extract.py assemble  --book 15
python pipeline/vocab.py --text claude:sonnet
```

- **ocr:** Tesseract on every page.
- **map:** finds tests, sections and answer keys from the page headers. No model.
- **units:** question groups, speaking frames and answer keys.
- **scripts:** cleans the Listening transcripts and repairs them against the audio with local Whisper.
- **proofread:** a model pass over the passages for real-word misreads, checked against the page images.
- **turns:** puts speaker names on dialogue turns the rules couldn't place.
- **assemble:** writes `content/camNN/testN.json` and runs the validators (40/40 answers, no numbering gaps, options present).

Model strings are `provider:model`, for example `claude:sonnet` or `ollama:<model>`. Any model error stops the run; run it again to resume from the cache.

## Hosting a copy

The app can also run on a small Ubuntu server for more than one person. The hosted copy adds sign-in with separate history, words and settings for each account, and leaves out Speaking. The scripts are in `deploy/`:

```
python deploy/pack.py                  # code, content, audio and your database -> bandsy-deploy.tar
sh /opt/bandsy/deploy/setup.sh <domain>   # on the server: installs Node and Caddy (HTTPS) and starts the service
sh /opt/bandsy/deploy/adduser.sh <name> <password>
```

Create your own account first: it takes over the history from your PC. For later updates, run `python deploy/pack.py --code`, upload the file, and run `setup.sh` again. It never overwrites the live database.

## Notes

The test content comes from Cambridge IELTS books. Keep this repository private.
