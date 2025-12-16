# SLT GEAR ONE — Live Visual Equalizer

A dark-themed, high-end live spectrum visualizer and VU meter with input device selection. The input is never routed to speakers.

## Features
- Input device selection (choose any available microphone/interface)
- High-resolution spectrum with logarithmic bars and peak-hold
- Precise VU meter with RMS and Peak dBFS, peak-hold marker
- Dark, modern UI

## Run locally
Most browsers require HTTPS or `http://localhost` for microphone access.

- Option A (Node):
  ```bash
  npx http-server -p 5173 -c-1 .
  # then open http://localhost:5173/SLT%20UPDATE/index.html
  ```
- Option B (Python):
  ```bash
  python -m http.server 5173
  # then open http://localhost:5173/SLT%20UPDATE/index.html
  ```
- Option C: Use your editor's Live Server extension.

Grant microphone permission when prompted. Then choose your input device and click Start. Use Refresh if device labels are empty after first permission grant.

## Notes
- Audio is not connected to the output, so nothing is played through speakers.
- If you change input devices while running, the app will switch after a brief restart. # audiom
