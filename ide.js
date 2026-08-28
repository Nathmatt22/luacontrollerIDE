// ide.js -- Main logic of the Luacontroller IDE

// ---------------------------------------------------------------------------
// Autocompletion data (Luacontroller API)
// ---------------------------------------------------------------------------
const LC_GLOBALS = {
	pin: "Real (boolean) state of the 4 ports a, b, c, d (inputs + driven outputs).",
	port: "Outputs the controller can drive. Writing port.a = true activates port A.",
	event: "Table of the current event: .type, .pin, .channel, .msg, .iid.",
	mem: "Persistent memory table kept between executions.",
	heat: "Current heat of the controller (overheats beyond heat_max).",
	heat_max: "Maximum heat before burning out (20 by default).",
	print: "print(...) -- writes to the controller console.",
	interrupt: "interrupt(time, iid?) -- schedules a future execution after time seconds.",
	digiline_send: "digiline_send(channel, msg) -- sends a message on a digiline channel.",
	clean_and_weigh_digiline_message: undefined,
	overheat: undefined,
};

const LIB_DOCS = {
	string: {
		byte: "string.byte(s [, i [, j]]) -- byte codes of a string.",
		char: "string.char(...) -- converts byte codes into a string.",
		format: "string.format(fmt, ...) -- formats (like printf).",
		len: "string.len(s) -- length of a string (#s).",
		lower: "string.lower(s) -- lowercase.",
		upper: "string.upper(s) -- uppercase.",
		rep: "string.rep(s, n) -- repeats n times (max size protected).",
		reverse: "string.reverse(s) -- reverses a string.",
		sub: "string.sub(s, i [, j]) -- substring.",
		find: "string.find(s, p [, plain]) -- search (plain required in the mod).",
		match: "string.match(s, p) -- extracts the first match.",
		gsub: "string.gsub(s, p, r) -- global replacement.",
		gmatch: "string.gmatch(s, p) -- match iterator.",
	},
	math: {
		abs: "math.abs(x)", acos: "math.acos(x)", asin: "math.asin(x)",
		atan: "math.atan(x)", atan2: "math.atan2(y, x)", ceil: "math.ceil(x)",
		cos: "math.cos(x)", cosh: "math.cosh(x)", deg: "math.deg(x)",
		exp: "math.exp(x)", floor: "math.floor(x)", fmod: "math.fmod(x, y)",
		frexp: "math.frexp(x)", huge: "math.huge", ldexp: "math.ldexp(m, e)",
		log: "math.log(x)", log10: "math.log10(x)", max: "math.max(...)",
		min: "math.min(...)", modf: "math.modf(x)", pi: "math.pi",
		pow: "math.pow(x, y)", rad: "math.rad(x)", random: "math.random([m [, n]])",
		randomseed: "math.randomseed(x)", sin: "math.sin(x)", sinh: "math.sinh(x)",
		sqrt: "math.sqrt(x)", tan: "math.tan(x)", tanh: "math.tanh(x)",
	},
	table: {
		concat: "table.concat(t [, sep [, i [, j]]])",
		insert: "table.insert(t [, pos], value)",
		maxn: "table.maxn(t)",
		remove: "table.remove(t [, pos])",
		sort: "table.sort(t [, comp])",
		unpack: "table.unpack(t [, i [, j]])",
	},
	os: {
		clock: "os.clock() -- CPU time used.",
		difftime: "os.difftime(t2, t1) -- time difference.",
		time: "os.time() -- current system time.",
		datetable: "os.datetable() -- local date/time table ({year, month, day, ...}).",
	},
};

const LC_EXTRA_DOCS = {
	sha256sum: "sha256sum(str) -- SHA-256 hash of a string (useful for identifiers).",
};

// Built-in Lua functions available in the Luacontroller sandbox
const BUILTIN_DOCS = {
	assert: "assert(v [, msg]) -- raises an error if v is falsey.",
	error: "error(msg [, level]) -- raises an error.",
	ipairs: "ipairs(t) -- iterator over the array part of t.",
	next: "next(t [, k]) -- returns the next key/value pair.",
	pairs: "pairs(t) -- iterator over all key/value pairs.",
	pcall: "pcall(f, ...) -- calls f, returns ok plus results.",
	xpcall: "xpcall(f, msgh, ...) -- pcall with a message handler.",
	select: "select(n, ...) -- returns the n-th argument, or the count with '#',",
	tonumber: "tonumber(v [, base]) -- converts a value to a number.",
	tostring: "tostring(v) -- converts a value to a string.",
	type: "type(v) -- returns the type name of v.",
	unpack: "unpack(t [, i [, j]]) -- returns the elements of the array part of t.",
	_VERSION: "_VERSION -- Lua version string.",
	string: "string -- string library (string.format, string.sub, ...).",
	math: "math -- math library (math.floor, math.random, ...).",
	table: "table -- table library (table.insert, table.concat, ...).",
	os: "os -- restricted os library (os.time, os.clock, ...).",
};

// Member completions for controller tables (event / pin / port)
const MEMBER_DOCS = {
	event: {
		type: "event.type -- event kind: \"program\", \"on\", \"off\", \"interrupt\", \"digiline\"",
		pin: "event.pin -- port table {x, y, z, name} (on/off events)",
		channel: "event.channel -- digiline channel (digiline events)",
		msg: "event.msg -- digiline message (digiline events)",
		iid: "event.iid -- interrupt ID (interrupt events)",
	},
	pin: {
		a: "pin.a -- real state of port A (input or driven output)",
		b: "pin.b -- real state of port B (input or driven output)",
		c: "pin.c -- real state of port C (input or driven output)",
		d: "pin.d -- real state of port D (input or driven output)",
	},
	port: {
		a: "port.a -- set to true/false to drive output A",
		b: "port.b -- set to true/false to drive output B",
		c: "port.c -- set to true/false to drive output C",
		d: "port.d -- set to true/false to drive output D",
	},
};

// ---------------------------------------------------------------------------
// CodeMirror: editor + autocompletion
// ---------------------------------------------------------------------------
const editor = CodeMirror.fromTextArea(document.getElementById("code"), {
	mode: "lua",
	theme: "monokai",
	lineNumbers: true,
	styleActiveLine: true,
	indentUnit: 2,
	tabSize: 2,
	indentWithTabs: false,
	matchBrackets: true,
	extraKeys: {
		"Ctrl-Space": "autocomplete",
		"Ctrl-Enter": runProgram,
		"Cmd-Enter": runProgram,
		Fallthrough: ""
	},
});

// Expose the instance for debugging / external scripts
window.ide_editor = editor;

let autocompleteList = buildAutocomplete();
function buildAutocomplete() {
	const list = {};
	for (const k in LC_GLOBALS) {
		if (LC_GLOBALS[k] === undefined) continue;
		list[k] = LC_GLOBALS[k];
	}
	for (const k in LC_EXTRA_DOCS) list[k] = LC_EXTRA_DOCS[k];
	for (const k in BUILTIN_DOCS) list[k] = BUILTIN_DOCS[k];
	return list;
}

// Custom hint: completes globals, library/controller members and event.type values
function luaControllerHint(cm) {
	const cur = cm.getCursor();
	const line = cm.getLine(cur.line);
	const start = cur.ch;

	// Values for `event.type == "..."` / `event.pin.name == "..."` (cursor before or inside the string)
	const linePrefix = line.slice(0, start);
	const valueCtx = /(event\.type|event\.pin\.name)\s*==\s*(["'])([^"']*)$/.exec(linePrefix);
	if (valueCtx) {
		const isType = valueCtx[1] === "event.type";
		const typed = valueCtx[3];
		const values = isType
			? [
				{ text: "program", doc: "Fired when the program is loaded." },
				{ text: "on", doc: "Fired when an input port turns on." },
				{ text: "off", doc: "Fired when an input port turns off." },
				{ text: "interrupt", doc: "Fired by interrupt(time)." },
				{ text: "digiline", doc: "Fired by a received digiline message." },
			]
			: ["A", "B", "C", "D"].map((n) => ({ text: n, doc: "Port name " + n + " (on/off events)." }));
		const filtered = values.filter((v) => v.text.toLowerCase().startsWith(typed.toLowerCase()));
		return {
			list: filtered.map((v) => ({ text: v.text, doc: v.doc, render: renderHintItem })),
			from: { line: cur.line, ch: start - typed.length },
			to: { line: cur.line, ch: start },
		};
	}

	// Don't suggest inside a string or a comment
	const token = cm.getTokenAt(cur);
	if (token && token.type && /string|comment/.test(token.type)) {
		return { list: [], from: { line: cur.line, ch: start }, to: { line: cur.line, ch: start } };
	}

	const match = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]*)?)$/.exec(line.slice(0, start));
	let word = match ? match[1] : "";
	let from = { line: cur.line, ch: start - word.length };
	let to = { line: cur.line, ch: start };

	const suggestions = [];
	const baseMatch = /([A-Za-z0-9_]+)\.([A-Za-z0-9_]*)$/.exec(word);
	if (baseMatch) {
		const lib = baseMatch[1];
		const suffix = baseMatch[2];
		const docs = LIB_DOCS[lib] || MEMBER_DOCS[lib];
		if (!docs) {
			// Unknown base (e.g. a user variable): no suggestions
			return { list: [], from: { line: cur.line, ch: start - suffix.length }, to };
		}
		const isLib = !!LIB_DOCS[lib];
		from = { line: cur.line, ch: start - suffix.length };
		for (const fn in docs) {
			if (!suffix || fn.startsWith(suffix)) {
				suggestions.push({ text: fn + (isLib ? "(" : ""), displayText: lib + "." + fn, doc: docs[fn] });
			}
		}
	} else {
		for (const g in autocompleteList) {
			if (!g.startsWith(word)) continue;				suggestions.push({ text: g, doc: autocompleteList[g] });
		}
	}

	return {
		list: suggestions.map((s) => ({
			text: s.text,
			displayText: s.displayText || s.text,
			doc: s.doc,
			render: renderHintItem,
		})),
		from,
		to,
	};
}

// Renders one popup item: name on the first line, documentation below.
// Note: the doc goes in a custom `doc` field — the `hint` field of a CM5 hint
// item is a function called on pick, and must stay unset so Tab/Enter insert `text`.
function renderHintItem(elt, data, cur) {
	elt.textContent = "";
	const line = document.createElement("div");
	line.className = "cm-hint-line";
	line.textContent = cur.displayText || cur.text;
	elt.appendChild(line);
	if (cur.doc) {
		const detail = document.createElement("div");
		detail.className = "cm-hint-detail";
		detail.textContent = cur.doc;
		elt.appendChild(detail);
	}
}

CodeMirror.registerHelper("hint", "luaController", luaControllerHint);
editor.setOption("hintOptions", { hint: luaControllerHint, completeSingle: true });

// Automatic completion while typing (no auto-picking of a single match)
editor.on("inputRead", (cm, change) => {
	if (cm.state.completionActive) return;
	const last = change.text[change.text.length - 1] || "";
	if (!/^[A-Za-z0-9_.]$/.test(last)) return;
	cm.showHint({ hint: luaControllerHint, completeSingle: false });
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const worker = new Worker("luac_worker.js");

const SAMPLE = {
	blink: `-- Blinker: toggles LED B every 1 second
if event.type == "program" then
	print("Blinker started")
	interrupt(1)
elseif event.type == "interrupt" then
	port.b = not port.b
	interrupt(1)
end`,
	counter: `-- Pulse counter on port A (persistent memory mem)
mem.count = mem.count or 0

if event.type == "on" and event.pin.name == "A" then
	mem.count = mem.count + 1
	print("Pulse #" .. mem.count)
	port.c = (mem.count % 2 == 0)
end

-- Periodic display
if event.type == "program" then
	print("Counter ready. Send a pulse on port A.")
	interrupt(5)
elseif event.type == "interrupt" then
	print("Pulse count: " .. mem.count)
	interrupt(5)
end`,
	gate: `-- Logic AND gate: output D is active if and only if
-- inputs A AND B are active.
if pin.a and pin.b then
	port.d = true
else
	port.d = false
end

-- Log on every change
if event.type == "on" or event.type == "off" then
	local state = (pin.a and pin.b) and "active" or "inactive"
	print("AND(A="..tostring(pin.a)..", B="..tostring(pin.b)..") : output D " .. state)
end`,
	digilines: `-- Exchange on the Digiline channel 'my_channel'
--
-- Reception
if event.type == "digiline" then
	print("Received on " .. event.channel .. ": " .. tostring(event.msg))
	if type(event.msg) == "table" then
		-- echo back the sum of the received numbers
		local sum = 0
		for _, v in ipairs(event.msg) do
			sum = sum + tonumber(v) or 0
		end
		digiline_send(event.channel, {echo = true, sum = sum})
	end
end

-- Periodic emission
if event.type == "program" then
	print("Digiline controller ready.")
	interrupt(3)
elseif event.type == "interrupt" then
	digiline_send("my_channel", {n = 1, i = math.random(1, 100)})
	print("Message sent on my_channel")
	interrupt(3)
end`,
};

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------
const els = {
	runBtn: document.getElementById("runBtn"),
	sampleSelect: document.getElementById("sampleSelect"),
	statusText: document.getElementById("statusText"),
	statusbar: document.getElementById("statusbar"),
	console: document.getElementById("console"),
	// ports
	pinA: document.getElementById("pinA"),
	pinB: document.getElementById("pinB"),
	pinC: document.getElementById("pinC"),
	pinD: document.getElementById("pinD"),
	// digiline
	digiChan: document.getElementById("digiChan"),
	digiMsg: document.getElementById("digiMsg"),
	digiSend: document.getElementById("digiSend"),
	digiLog: document.getElementById("digiLog"),
	// internal state
	timersCount: document.getElementById("timersCount"),
	heatVal: document.getElementById("heatVal"),
	heatMax: document.getElementById("heatMax"),
	memView: document.getElementById("memView"),
	// simulation
	stepTimer: document.getElementById("stepTimer"),
	autoTimer: document.getElementById("autoTimer"),
	resetBtn: document.getElementById("resetBtn"),
};

let rportsUI = { a: false, b: false, c: false, d: false };
let autoStepHandle = null;
let outputLEDs = { a: false, b: false, c: false, d: false };

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------
function clearConsole() {
	let lines = "";
	els.console.innerHTML = "";
	els.console.textContent = "—";
}
function writeConsole(text, cls) {
	if (els.console.textContent === "—") els.console.textContent = "";
	const span = document.createElement("span");
	span.className = cls || "print";
	span.textContent = text;
	els.console.appendChild(span);
	els.console.appendChild(document.createTextNode("\n"));
	els.console.scrollTop = els.console.scrollHeight;
}

function setStatus(msg, cls) {
	els.statusbar.textContent = msg;
	els.statusbar.className = cls || "";
}

// ---------------------------------------------------------------------------
// Rendering outputs (LEDs) and inputs
// ---------------------------------------------------------------------------
const pinRowEl = {
	a: document.querySelector(".pinline").cloneNode(true),
};
function renderOutputs(vports) {
	outputLEDs = vports;
	// Target by id (ledA..ledD) and only toggle the "on" class,
	// which preserves the base classes (pinState pinA...): no selector loss.
	const map = { a: "ledA", b: "ledB", c: "ledC", d: "ledD" };
	for (const p in map) {
		const led = document.getElementById(map[p]);
		if (led) led.classList.toggle("on", !!vports[p]);
	}
}
function renderInputs(rports) {
	rportsUI = rports;
	const map = { a: "#pinA", b: "#pinB", c: "#pinC", d: "#pinD" };
	for (const p in map) {
		const cb = document.querySelector(map[p]);
		if (cb && cb.checked !== !!rports[p]) cb.checked = !!rports[p];
	}
}

// ---------------------------------------------------------------------------
// Port interactions (input switches)
// ---------------------------------------------------------------------------
function bindPortToggle(name, el) {
	el.addEventListener("change", () => {
		rportsUI[name] = el.checked;
		const state = el.checked ? "on" : "off";
		// IMPORTANT: update the input state BEFORE sending the event,
		// otherwise the event is processed with rports still false and the switch
		// gets unchecked again (inconsistent rendering "jumps").
		worker.postMessage({ type: "set_ports", rports: rportsUI });
		worker.postMessage({ type: "queue_event", event: { type: state, pin: { x: 0, y: 0, z: 0, name: name.toUpperCase() } } });
	});
}
bindPortToggle("a", els.pinA);
bindPortToggle("b", els.pinB);
bindPortToggle("c", els.pinC);
bindPortToggle("d", els.pinD);

// ---------------------------------------------------------------------------
// Digilines
// ---------------------------------------------------------------------------
function logDigiline(dir, entry) {
	const div = document.createElement("div");
	div.className = "digiline-entry";
	const chSpan = document.createElement("span");
	chSpan.className = "ch";
	chSpan.textContent = String(entry.channel);
	const dirSpan = document.createElement("span");
	dirSpan.className = "dir";
	dirSpan.textContent = dir;
	let msg = "";
	try { msg = JSON.stringify(entry.msg); } catch (e) { msg = String(entry.msg); }
	div.appendChild(dirSpan);
	div.appendChild(document.createTextNode(" "));
	div.appendChild(chSpan);
	div.appendChild(document.createTextNode(" : "));
	div.appendChild(document.createTextNode(msg));
	els.digiLog.appendChild(div);
	els.digiLog.scrollTop = els.digiLog.scrollHeight;
}

// ---------------------------------------------------------------------------
// Simulation: timers & clock
// ---------------------------------------------------------------------------
function stepSimulation(dt) {
	worker.postMessage({ type: "step", dt });
}
function startAutoCCash() {
	stopAutoCCash();
	autoStepHandle = setInterval(() => stepSimulation(0.5), 1000);
}
function stopAutoCCash() {
	if (autoStepHandle) { clearInterval(autoStepHandle); autoStepHandle = null; }
}

// ---------------------------------------------------------------------------
// Programs (run)
// ---------------------------------------------------------------------------
function runProgram() {
	const code = editor.getValue();
	worker.postMessage({ type: "set_code", code });
	// "program" event: reload
	const rportsSnapshot = { ...rportsUI };
	worker.postMessage({
		type: "queue_event",
		event: { type: "program" },
	});
	// Force re-render of inputs (in case the program changed them)
	// not needed; inputs are external.
	console.log("Program sent");
	setStatus("Program loaded.", "ok");
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------
els.sampleSelect.addEventListener("change", () => {
	const key = els.sampleSelect.value;
	if (key && SAMPLE[key]) {
		editor.setValue(SAMPLE[key]);
		setStatus('Sample "' + key + '" loaded.', "");
	}
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
els.runBtn.addEventListener("click", runProgram);
els.stepTimer.addEventListener("click", () => stepSimulation(0.5));
els.digiSend.addEventListener("click", () => {
	const chan = els.digiChan.value;
	let msg = els.digiMsg.value.trim();
	// Parse the message (JSON if possible, otherwise raw string)
	let parsed = msg;
	try { parsed = JSON.parse(msg); } catch (e) { parsed = msg; }
	logDigiline("↓", { channel: chan, msg: parsed });
	worker.postMessage({ type: "queue_event", event: { type: "digiline", channel: chan, msg: parsed } });
});
els.autoTimer.addEventListener("change", () => {
	if (els.autoTimer.checked) startAutoCCash(); else stopAutoCCash();
});
els.resetBtn.addEventListener("click", () => {
	worker.postMessage({ type: "reset" });
	clearConsole();
	renderOutputs({ a: false, b: false, c: false, d: false });
	rportsUI = { a: false, b: false, c: false, d: false };
	renderInputs(rportsUI);
	setStatus("Simulation reset.", "");
});
// ---------------------------------------------------------------------------
// API documentation (Docs modal)
// ---------------------------------------------------------------------------
const LC_DOCS = [
	{
		title: "Variables",
		entries: [
			{ term: "pin.a / pin.b / pin.c / pin.d", code: "pin.a", desc: "Real state (boolean) of the 4 ports: true when the input is on OR the output is driven." },
			{ term: "port.a / port.b / port.c / port.d", code: "port.a = true", desc: "Outputs the controller can drive. Assign a boolean to switch the port on/off." },
			{ term: "event", code: "event.type", desc: "Table describing the current event: .type, .pin, .channel, .msg, .iid." },
			{ term: "mem", code: "mem.count = mem.count or 0", desc: "Persistent memory table, kept between events until the simulation is reset." },
			{ term: "heat", code: "heat", desc: "Current controller heat. Reaching heat_max burns the controller out." },
			{ term: "heat_max", code: "heat_max", desc: "Maximum heat before burnout (20 by default)." },
		],
	},
	{
		title: "Functions",
		entries: [
			{ term: "print(...)", code: "print(\"hello\", mem.count)", desc: "Writes a line to the controller console." },
			{ term: "interrupt(time, iid?)", code: "interrupt(1)", desc: "Schedules an \"interrupt\" event after time seconds. Interrupt IDs (iid) are disabled in this simulation, like on most servers." },
			{ term: "digiline_send(channel, msg)", code: "digiline_send(\"chan\", {n = 1})", desc: "Sends a message on a digiline channel. msg must be JSON-serializable (string, number, boolean, or a table of those)." },
			{ term: "sha256sum(str)", code: "sha256sum(\"abc\")", desc: "Returns the SHA-256 hash of a string (useful for identifiers)." },
		],
	},
	{
		title: "Events",
		entries: [
			{ term: "\"program\"", code: "event.type == \"program\"", desc: "Fired when the program is loaded or re-run." },
			{ term: "\"on\" / \"off\"", code: "event.type == \"on\"", desc: "Fired when an input port is switched on/off. event.pin.name is \"A\", \"B\", \"C\" or \"D\"." },
			{ term: "\"interrupt\"", code: "event.type == \"interrupt\"", desc: "Fired when a timer scheduled with interrupt(time) expires." },
			{ term: "\"digiline\"", code: "event.type == \"digiline\"", desc: "Fired when a digiline message is received: event.channel and event.msg are set." },
		],
	},
	{
		title: "Libraries",
		entries: [
			{ term: "string", code: "string.format(\"%d\", n)", desc: "byte, char, format, len, lower, upper, rep, reverse, sub, find, match, gsub, gmatch." },
			{ term: "math", code: "math.random(1, 6)", desc: "abs, acos, asin, atan, atan2, ceil, cos, cosh, deg, exp, floor, fmod, frexp, huge, ldexp, log, log10, max, min, modf, pi, pow, rad, random, randomseed, sin, sinh, sqrt, tan, tanh." },
			{ term: "table", code: "table.insert(t, v)", desc: "concat, insert, maxn, remove, sort, unpack." },
			{ term: "os", code: "os.time()", desc: "clock, difftime, time, datetable (local date/time table)." },
		],
	},
	{
		title: "Sandbox & limits",
		entries: [
			{ term: "Safe globals", code: "pairs, pcall, type, ...", desc: "assert, error, ipairs, next, pairs, pcall, select, tonumber, tostring, type, unpack, xpcall, _VERSION." },
			{ term: "Blocked", code: "io, require, load, os.execute", desc: "io, require, load, loadstring, dofile, os.execute, os.remove, package, debug and network access are not available." },
			{ term: "Port coercion", code: "port.a = \"x\"", desc: "Outputs are coerced to booleans: any truthy value becomes true, nil/false become false." },
			{ term: "Errors", code: "error(\"boom\")", desc: "An error in the code burns the controller out (like the mod): the program is cleared and the error is shown." },
			{ term: "Memory persistence", code: "mem", desc: "mem is kept between events. Reset everything with the ↺ Reset button." },
		],
	},
];

function renderDocs(filter) {
	const body = document.getElementById("docsBody");
	body.innerHTML = "";
	const q = (filter || "").trim().toLowerCase();
	let any = false;
	for (const section of LC_DOCS) {
		const entries = section.entries.filter((e) =>
			!q || e.term.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q) || (e.code || "").toLowerCase().includes(q)
		);
		if (!entries.length) continue;
		any = true;
		const sec = document.createElement("section");
		sec.className = "docs-section";
		const h = document.createElement("h3");
		h.textContent = section.title;
		sec.appendChild(h);
		for (const e of entries) {
			const item = document.createElement("div");
			item.className = "docs-item";
			const term = document.createElement("div");
			term.className = "docs-term";
			term.textContent = e.term;
			item.appendChild(term);
			if (e.code) {
				const code = document.createElement("div");
				code.className = "docs-code";
				code.textContent = e.code;
				item.appendChild(code);
			}
			const desc = document.createElement("div");
			desc.className = "docs-desc";
			desc.textContent = e.desc;
			item.appendChild(desc);
			sec.appendChild(item);
		}
		body.appendChild(sec);
	}
	body.classList.toggle("empty", !any);
}

function openDocs() {
	document.getElementById("docsModal").classList.remove("hidden");
	document.getElementById("docsSearch").value = "";
	renderDocs("");
	document.getElementById("docsSearch").focus();
}
function closeDocs() {
	document.getElementById("docsModal").classList.add("hidden");
}

document.getElementById("docsBtn").addEventListener("click", openDocs);
document.getElementById("docsClose").addEventListener("click", closeDocs);
document.getElementById("docsBackdrop").addEventListener("click", closeDocs);
document.getElementById("docsSearch").addEventListener("input", (e) => renderDocs(e.target.value));
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closeDocs();
});

// initialize mem view
els.heatMax.textContent = "20";

// ---------------------------------------------------------------------------
// Worker messages
// ---------------------------------------------------------------------------
worker.onmessage = (e) => {
	const msg = e.data;
	switch (msg.type) {
		case "ready":
			// Wait for the initial code
			runProgram();
			break;

		case "state":
			renderInputs(msg.rports || rportsUI);
			renderOutputs(msg.vports);
			els.timersCount.textContent = msg.timers;
			els.heatVal.textContent = msg.heat;
			els.heatMax.textContent = msg.heatMax;
			renderMem(msg.mem);
			break;

		case "batch_results":
			for (const r of msg.results) {
				if (r.error) {
					writeConsole(r.msg || "Error", "err");
					setStatus("Error: " + (r.msg || ""), "error");
					continue;
				}
				if (r.skipped) continue;
				if (r.printed && r.printed.length) {
					for (const p of r.printed) writeConsole(p, "print");
				}
				if (r.msg) {
					if (String(r.msg).startsWith("Warning:")) writeConsole(r.msg, "warn");
					else writeConsole(r.msg, "print");
				}
				if (r.ds && r.ds.length) {
					for (const d of r.ds) logDigiline("→", d);
				}
			}
			break;

		case "timers":
			els.timersCount.textContent = msg.count;
			break;

		case "program_error":
			writeConsole("✖ " + (msg.msg || "Unknown error"), "err");
			setStatus("Error: " + (msg.msg || ""), "error");
			break;

		case "reset_done":
			els.timersCount.textContent = "0";
			break;

		default:
			break;
	}
};

function renderMem(mem) {
	let str;
	try { str = JSON.stringify(mem, null, 2); } catch (e) { str = String(mem); }
	els.memView.textContent = str || "{}";
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
window.addEventListener("load", () => {
	// print a help message
	writeConsole("Luacontroller IDE ready.", "sys");
	setStatus("Ready: write (or pick a sample), then click ▶ Run.", "");
	worker.postMessage({ type: "init" });
});