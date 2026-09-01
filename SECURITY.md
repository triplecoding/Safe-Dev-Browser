# Security

Dev Browser Safe is intended for local development only.

## Defaults

- The server binds to `127.0.0.1`.
- Remote target checks are blocked unless `ALLOW_REMOTE=1` is set.
- Runtime events are stored in process memory only.
- The preview iframe uses a browser sandbox.

## Recommended Use

- Add `agent-bridge.js` only in development.
- Do not deploy the bridge tag to production.
- Use `HOST=0.0.0.0` only on a trusted network.
- Review bridge events before sharing exported reports because console output can contain sensitive development data.

## Reporting Issues

Open a GitHub issue with reproduction steps and the affected version.
