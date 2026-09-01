# Dev Browser Safe

Dev Browser Safe is a local-first preview dashboard for coding agents and web builders. It gives Claude Code, Codex, or any other local coding workflow a shared browser surface for checking work while a site is being built.

## What it does

- Opens any local dev URL in a sandboxed preview frame.
- Switches between desktop, phone, tablet, and wide viewport presets.
- Runs basic server-side checks for response status, HTML, title, image alt text, and empty buttons.
- Streams console logs, runtime errors, unhandled promise rejections, fetch calls, XHR calls, and page-load signals through a small bridge script.
- Exports a Markdown build report with notes, failed checks, and runtime counts.
- Keeps bridge events in memory only.
- Blocks remote URL checks by default. Start with `ALLOW_REMOTE=1` only when you intentionally want remote checks.

## Install From GitHub

Clone the repository, then run:

```bash
node server.js
```

Open:

```text
http://127.0.0.1:4577
```

No package install is required because the server uses only Node.js built-ins. If you prefer npm scripts, `npm start` runs the same server.

## Use With Any Project

1. Start your app, for example at `http://localhost:3000`.
2. Start Dev Browser Safe with `npm start`.
3. Open `http://127.0.0.1:4577`.
4. Enter your app URL in the address bar.
5. For live runtime signals, add this tag to your dev HTML:

```html
<script src="http://127.0.0.1:4577/agent-bridge.js"></script>
```

For Vite, Next.js, Astro, or plain HTML, add it only in development. Remove it before production builds.

## Safety Notes

- The dashboard binds to `127.0.0.1` by default.
- Remote checks are blocked unless `ALLOW_REMOTE=1` is set.
- The iframe preview uses a browser sandbox.
- The bridge sends events only to your local dashboard endpoint.
- The server stores recent events in memory and does not write browsing data to disk.

## Configuration

```bash
PORT=4577 npm start
ALLOW_REMOTE=1 npm start
HOST=0.0.0.0 npm start
```

Use `HOST=0.0.0.0` only on a trusted network.

## Agent Workflow

When an agent is building a site:

1. Keep the target app running.
2. Keep Dev Browser Safe open beside the coding session.
3. Ask the agent to open the target URL, run checks, and watch the live signals after each visible change.
4. Export a report before handoff.

This gives the agent a fast feedback loop similar to a dedicated development browser while staying simple enough to install from a GitHub repository.
