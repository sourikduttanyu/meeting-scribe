# meeting-scribe

Video meetings with a pseudo-realtime AI timeline. A hidden server-side "Scribe" peer captures each participant's audio and screen share, a plugin pipeline turns it into timestamped events (captions, screen text, rolling summaries), and late joiners can ask things like *"what happened in the first 5 minutes?"*

Runs fully local and free on an Apple Silicon Mac (whisper.cpp + Ollama), designed with a clear path to SFU-based scale.

- Architecture & conventions: [CLAUDE.md](CLAUDE.md)
- Phases, scale path, decisions & critiques: [PLAN.md](PLAN.md)

Status: early POC — see PLAN.md.
