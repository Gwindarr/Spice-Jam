# WORM Multiplayer Notes

Date: 2026-04-11

## Summary

The multiplayer worm regressions were primarily authority and state-ownership problems, not simple tuning drift.

Pre-multiplayer, the worm was effectively a rich local actor. Multiplayer initially replaced that with a thinner server phase machine and a reduced client presentation path. That broke lure behavior, warning/breach sequencing, and devour flow.

The current local fixes move the worm back toward server authority while preserving the original feel:

- server sim owns worm movement, state, targeting, breach, devour, and recover
- client renders the server worm state instead of running its own separate multiplayer worm logic
- worm-specific events are handled separately from generic PvP death

## Main Regressions Seen

### 1. Thumper did not reliably summon the worm

Observed symptoms:

- worm bar increased but worm did not commit to the thumper
- thumper lure felt weaker than before

Root causes:

- client HUD could spike from local thumper signal even if the server had not committed to the lure
- server hotspot falloff was initially evaluated against the average player cluster, which weakened thumpers when players spread out
- thumper pulses were not treated strongly enough as authoritative lure events on the server

Current fixes:

- hotspot falloff uses nearest active player distance instead of cluster center
- thumper pulses emit explicit server noise hotspots
- server `noiseHotspot` handling treats `thumper` as a real lure source and can spawn/retarget the worm immediately

### 2. Worm started from the thumper, then killed the player anyway

Observed symptoms:

- thumper triggered a correct breach event
- immediately after that, a second strike happened at player location

Root causes:

- worm could retarget after committing to the thumper
- breach target was still allowed to drift from fresh player noise during breach

Current fixes:

- server stores worm target source/owner when locking a lure
- thumper targets stay locked to the owning thumper while active
- breach no longer retargets after warning resolves into breach

Rule of record:

- if the worm is chasing a thumper, it should chase the thumper, not the player

### 3. Atomic detonation caused instant worm appearance / unfair kill behavior

Observed symptoms:

- atomic could appear to skip normal warning/breach feel
- kills could feel disconnected from the visible strike point

Root causes:

- atomic path forced strong worm reaction immediately
- client/server state splits made the visual sequence harder to trust

Current status:

- atomic remains a deliberately extreme lure
- if atomic behavior still feels wrong, tune it after thumper behavior is stable

## Client-Side Stability Issues Seen During This Fix Pass

### 4. Game loaded only the shell UI / black background

Observed symptoms:

- HUD stayed at static defaults like `Time: 12:00` and `Pos: (0,0)`
- sometimes a brief flash of the world, then dark screen

Root causes:

- `animate()` previously ran after multiplayer init, so a synchronous multiplayer startup failure could leave the page on the static HTML shell
- multiplayer worm state was mixed into local worm actor state
- a bad multiplayer worm presentation frame could destabilize the client render path

Current fixes:

- local render loop starts before multiplayer init
- multiplayer init is wrapped defensively and can fail closed into offline mode
- network worm state is isolated from local worm actor state
- multiplayer worm visuals can fail closed without killing the whole frame loop

## Files With Important Fixes

- `server.js`
- `index.html`

## Recommended Test Cases

### Thumper

1. Deploy thumper on sand.
2. Move away from the thumper.
3. Expected:
   - worm is summoned
   - warning then breach occur at the thumper
   - player is not killed unless still inside the actual kill radius

### Atomic

1. Trigger atomic near player.
2. Trigger atomic far from player.
3. Expected:
   - worm reaction is extreme, but still visually coherent
   - kill should align with actual breach/strike location

### Multiplayer startup

1. Load local game with server running.
2. Load local game with server unavailable.
3. Expected:
   - local world still renders in both cases
   - multiplayer failure should not trap the page on the static shell

## If This Breaks Again

Check these in order:

1. Is the test definitely running on the intended server (`localhost` vs deployed)?
2. Is the worm target source still `thumper` after lure lock?
3. Is breach retargeting disabled after warning lock?
4. Is the client reading network worm state separately from local worm state?
5. Did a multiplayer startup failure stop `animate()` from advancing?

## Likely Future Tuning Work

- tune thumper attraction timing/intensity
- tune atomic warning/breach feel
- tune kill radius / pull strength to match the original jam feel more closely
