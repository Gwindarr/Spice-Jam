# Vultr deployment

The game is served by Caddy at `https://api.bananatriangles.com`, proxying to
`127.0.0.1:3001`. Both the HTML game and Socket.IO use that endpoint.

The `spice-jam` systemd service runs as the dedicated `spice-jam` user, using
`/opt/node-v22/bin/node`. Releases live in `/opt/spice-jam/releases/`; the
`/opt/spice-jam/current` symlink selects the active release. The service has a read-only
filesystem view and cannot access home directories. Its definition is in
[`spice-jam.service`](spice-jam.service).

Each release contains `server.js`, `game-rules.js`, `static-files.js`, `world.js`,
`index.html`, `mobile-controls.js`, the package files, `vendor/`, and `assets/`.
Install locked runtime dependencies in the release with `npm ci --omit=dev` before
switching the symlink. Keep releases root-owned and readable by the service user.
Do not include `.git`, credentials, review evidence, or development dependencies.

Validate a new release on a separate loopback port before changing `current`, then
restart only `spice-jam.service`. Check the public page and Socket.IO handshake.

```bash
systemctl status spice-jam --no-pager
journalctl -u spice-jam -n 50 --no-pager
curl -I https://api.bananatriangles.com/
```

To roll back, point `current` at a previously verified release and restart the service.
Game state is in memory; restarting clears players, scores, and the current map.
The old `/opt/vibejam2026` checkout and its untracked assets are retained for reference.
Its former PM2 process should stay stopped to avoid competing for port 3001.
