# Luacontroller IDE

**Offline** web editor + simulator for the [Luacontroller](https://mesecons.net/) block of the `mesecons_luacontroller` mod (Mesecons / Minetest).

It lets you write Lua code with autocompletion, then **test it in the browser** by simulating ports, timers and digilines — without needing the game.

> ⚠️ This is an **educational simulation**: it faithfully reproduces the *sandbox* and the execution model of the mod (same environment, same limits and behaviors), but it does not replace a real in-game controller.

## Usage

1. **Pick a sample** from the dropdown (or write your own code).
2. Click **▶ Run** (or `Ctrl+Enter`) to load the program.
3. **Simulate**:
   - Toggle the **A / B / C / D** switches to send input signals (`on` / `off`).
   - **⏱ Advance timers +0.5 s** to fire the `interrupt(...)` events.
   - **Send to controller** to simulate receiving a digiline message on the given channel.
   - **↺ Reset** to zero the memory, ports and clock.
4. Watch the panel: port outputs (green LEDs), console (`print`), digiline messages, `mem` contents, heat.
5. Click **?** in the header to open the **API reference** (variables, functions, events, libraries, sandbox limits) with a search box.

Editor shortcuts: `Ctrl+Space` -> autocomplete (completion also pops up automatically while typing), `Ctrl+Enter` -> Run.

---

## What is simulated

The code environment is **the same** as a real Luacontroller:

- **Variables**: `pin.*`, `port.*`, `event`, `mem`, `heat`, `heat_max`
- **Functions**: `print`, `interrupt(time, iid)`, `digiline_send(channel, msg)`, `sha256sum`
- **Restricted libraries**: `string.*`, `math.*`, `table.*`, `os.*` (limited), safe globals (`pairs`, `pcall`, `type`, ...)
- **Blocked**: `io`, `require`, `load`, `dofile`, `os.execute`, network access, etc. (dangerous ones removed from the environment)
- **Events**: `"program"`, `"on"` / `"off"` (ports), `"interrupt"` (timers), `"digiline"`
- **Persistence** of `mem` between events, like in the game.
- Port outputs coerced to booleans, identical to the mod.

Known limitations of the simulation (deliberately simplified vs the game):
- The overheating (burn-out) setting is minimal; `heat` decreases slightly between events.
- Digilines are a **single logical bus** (no wiring or multiple connected controllers).
- There is no real `mesecons` layer: no current propagation or neighboring blocks; input comes from the switches.

---

## Structure

```
ide/
├── index.html        → main page (editor + simulation panel)
├── ide.js            → UI logic: CodeMirror, autocompletion, simulation, worker messages
├── luac_worker.js    → Web Worker: runs the code in the Lua sandbox (fengari)
├── fengari-web.js    → Lua 5.3 interpreter in JS (vendored for offline use)
├── style.css         → styles
└── README.md
```

The autocompletion covers the controller API (`pin`, `port`, `event`, `mem`, ...), the `string.` / `math.` / `table.` / `os.` members, the sandbox Lua built-ins, and the possible values of `event.type` / `event.pin.name` — each suggestion shows its documentation below the name.

---

## Ideas for the future

- Export / import of code (file, clipboard, URL sharing).
- Simulation of **several connected controllers** over a virtual digiline channel.
- Applying the `luacontroller_maxevents` setting (instruction limit) to detect infinite loops.
- Loading code directly into a real Minetest server (mod `itos`/HTTP) — would require a backend.
