// luac_worker.js
// Runs Luacontroller code in a sandbox environment faithful to the
// mesecons_luacontroller mod, using Fengari (Lua 5.3 emulated in JS).
//
// Design: user code runs in a Lua function loaded with loadstring and given a
// restricted environment (_ENV) built on the Lua side from data injected by JS:
// ports, event, mem, heat...

// fengari-web (UMD) references `window`, which is absent in a Web Worker.
// Point window to the global `self` object before importing it.
if (typeof window === "undefined") {
	self.window = self;
}
// Diagnostic wrapper: surface any failure during loading.
let lua, lauxlib, lualib, to_luastring;
try {
	importScripts("fengari-web.js");
	({ lua, lauxlib, lualib, to_luastring } = fengari);
} catch (err) {
	postMessage({ type: "__trace", error: "Failed to load fengari: " + String((err && err.stack) || err) });
}

let L = null; // lua_State
let ready = false;

// --- Simulated state -----------------------------------------------------------
let mem = {};              // controller persistent memory
let vports = { a: false, b: false, c: false, d: false }; // outputs driven by the program
let rports = { a: false, b: false, c: false, d: false }; // inputs (external signals)
let heat = 0;
let heatMax = 20;
let clock = 0;             // simulated clock (seconds)
let timers = [];           // [{ when, iid }]
const timersCount = () => timers.length;

let code = "";             // code currently loaded in the editor
let eventHooks = [];       // queue of events to submit in the next batch
let busy = false;

const PORT_NAMES = ["a", "b", "c", "d"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shallowCopy(o) {
	const r = {};
	for (const k in o) r[k] = o[k];
	return r;
}

function mergePortStates(whole, vports) {
	return {
		a: !!whole.a || !!vports.a,
		b: !!whole.b || !!vports.b,
		c: !!whole.c || !!vports.c,
		d: !!whole.d || !!vports.d,
	};
}

// ---------------------------------------------------------------------------
// State / messages
// ---------------------------------------------------------------------------
self.onmessage = (e) => {
	const msg = e.data;
	switch (msg.type) {
		case "init":
			if (!L) {
				L = lauxlib.luaL_newstate();
				lualib.luaL_openlibs(L);
			}
			ready = true;
			postMessage({ type: "ready" });
			break;

		case "set_code":
			code = msg.code || "";
			eventHooks.length = 0;
			break;

		case "set_ports":
			// User toggled an input switch.
			rports = msg.rports ? msg.rports : rports;
			break;

		case "fire_rports":
			// Send an "on"/"off" event on an input port from the switch.
			queueEvent({ type: msg.state, pin: msg.pin });
			break;

		case "step":
			// Advance the simulated clock by dt seconds, fire due timers, then process the queue.
			msgPauseGuard(() => {
				clock += msg.dt;
				const due = [];
				timers = timers.filter((t) => {
					if (t.when <= clock) { due.push(t); return false; }
					return true;
				});
				for (const t of due) {
					eventHooks.push({ type: "interrupt", iid: t.iid });
				}
			}, () => {
				postMessage({ type: "timers", count: timers.length });
				processBatch();
			});
			break;

		case "queue_event":
			queueEvent(msg.event);
			break;

		case "reset":
			mem = {};
			vports = { a: false, b: false, c: false, d: false };
			rports = { a: false, b: false, c: false, d: false };
			heat = 0;
			clock = 0;
			timers = [];
			eventHooks.length = 0;
			postMessage({ type: "reset_done" });
			break;

		default:
			break;
	}
};

// Preserve the original handler and surface unexpected JS exceptions
(function () {
	const original = self.onmessage;
	self.onmessage = function (e) {
		try {
			original.call(this, e);
		} catch (err) {
			postMessage({ type: "__trace", error: String((err && err.stack) || err) });
		}
	};
})();

function queueEvent(event) {
	eventHooks.push(event);
	if (!busy) processBatch();
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------
function processBatch() {
	if (eventHooks.length === 0) {
		broadcastState();
		return;
	}
	if (busy) return;
	busy = true;

	const batch = eventHooks;
	eventHooks = [];

	const results = [];
	let stop = false;
	for (const event of batch) {
		if (stop) { results.push({ skipped: true, event }); continue; }
		const r = runEvent(event);
		if (r.error) {
			// On error, the controller "burns out" like the mod (reset).
			onError(r.msg);
			results.push({ error: true, msg: r.msg, event });
			stop = true;
		} else {
			// Persist memory between events
			if (r.mem && typeof r.mem === "object") mem = r.mem;
			results.push(r);
		}
	}

	busy = false;

	postMessage({ type: "batch_results", results });

	// After applying the simulation effects
	if (!stop) {
		postMessage({ type: "timers", count: timers.length });
		heat = Math.max(0, heat - 1); // slight cooldown between events
	}
	broadcastState();
}

function broadcastState() {
	postMessage({
		type: "state",
		vports: shallowCopy(vports),
		rports: shallowCopy(rports),
		heat,
		heatMax,
		mem: shallowCopy(mem),
		clock,
		timers: timersCount(),
	});
}

function msgPauseGuard(pre, post) {
	// small helper: run pre under lock, then post+processing
	pre();
	post();
}

// ---------------------------------------------------------------------------
// Running an event in Lua
// ---------------------------------------------------------------------------
// Uses the Lua 5.3 API: `load(code, name, mode, env)` to set the chunk
// environment (setfenv is absent in 5.3).
function runEvent(event) {
	// Pass the data through globals that the Lua wrapper reads.
	lua.lua_settop(L, 0);
	setGlobal("__lc_code", code);
	setGlobal("__lc_event", JSON.stringify(event));
	setGlobal("__lc_vports_json", JSON.stringify(vports));
	setGlobal("__lc_rports_json", JSON.stringify(rports));
	setGlobal("__lc_mem_json", JSON.stringify(mem));
	setGlobal("__lc_heat", heat);
	setGlobal("__lc_heatmax", heatMax);

	const wrapper = `
	-- Build the Luacontroller environment and run the code once.
	local vports = __lc_load_json(__lc_vports_json)
	local rports = __lc_load_json(__lc_rports_json)
	local mem0   = __lc_load_json(__lc_mem_json) or {}
	local event  = __lc_load_json(__lc_event)

	local out = { printed = {}, port = {}, interrupt = nil, ds = {}, msg = nil,
	              mem = mem0, error = false }

	-- JSON encoding (trees only, cycle guard). All iteration happens in Lua.
	local json_seenv = {}
	local json_emit
	json_emit = function(v, mode)
		local tv = type(v)
		if tv == "number" then
			if v ~= v then mode[#mode + 1] = "null"
			else mode[#mode + 1] = string.format("%.14g", v) end
		elseif tv == "boolean" then
			mode[#mode + 1] = v and "true" or "false"
		elseif tv == "string" then
			mode[#mode + 1] = string.format("%q", v)
		elseif tv == "table" then
			if json_seenv[v] then mode[#mode + 1] = "null"; return end
			json_seenv[v] = true
			local isarr, n = true, 0
			for _ in pairs(v) do n = n + 1 end
			for i = 1, n do if v[i] == nil then isarr = false break end end
			if isarr then
				mode[#mode + 1] = "["
				for i = 1, n do
					if i > 1 then mode[#mode + 1] = "," end
					json_emit(v[i], mode)
				end
				mode[#mode + 1] = "]"
			else
				mode[#mode + 1] = "{"
				local first = true
				for k, val in pairs(v) do
					if type(k) == "string" then
						if not first then mode[#mode + 1] = "," end
						first = false
						mode[#mode + 1] = string.format("%q", k)
						mode[#mode + 1] = ":"
						json_emit(val, mode)
					end
				end
				mode[#mode + 1] = "}"
			end
			json_seenv[v] = nil
		else
			mode[#mode + 1] = "null"
		end
	end
	local function __lc_jsonenc(t)
		local acc = {}
		json_emit(t, acc)
		return table.concat(acc)
	end

	local function send_warning(m) out.msg = ("Warning: " .. m) end

	local function safe_print(...)
		local t = {...}
		for i = 1, select("#", ...) do t[i] = tostring(t[i]) end
		out.printed[#out.printed + 1] = table.concat(t, "\\t")
	end

	local function interrupt(time, iid)
		if type(time) ~= "number" then error("Delay must be a number") end
		out.interrupt = time
		if iid ~= nil and iid ~= "" then send_warning("Interrupt IDs are disabled on this server") end
	end

	local function digiline_send(channel, msg)
		out.ds[#out.ds + 1] = { channel = channel, msg = msg }
		return true
	end

	-- pin: real ports (external inputs OR driven outputs)
	local pin = {}
	for i, p in ipairs({ "a","b","c","d" }) do
		pin[p] = (rports[p] or vports[p])
	end

	-- Environment: exactly like in the mod
	local env = {}
	for _, n in ipairs({ "assert","error","ipairs","next","pairs","select","tonumber",
	                      "tostring","type","_VERSION","pcall","xpcall" }) do
		env[n] = _G[n]
	end
	env.unpack = table.unpack
	env.pin = pin
	env.port = __lc_shallow(vports)
	env.event = event
	env.mem = mem0
	env.heat = __lc_heat
	env.heat_max = __lc_heatmax
	env.print = safe_print
	env.interrupt = interrupt
	env.digiline_send = digiline_send
	env.string = { byte=string.byte, char=string.char, format=string.format, len=string.len,
	               lower=string.lower, upper=string.upper, rep=string.rep, reverse=string.reverse,
	               sub=string.sub, find=string.find, match=string.match, gsub=string.gsub,
	               gmatch=string.gmatch }
	env.math = __lc_shallow(math)
	env.table = __lc_shallow(table)
	env.os = { clock=os.clock, difftime=os.difftime, time=os.time,
	           datetable=function() return os.date("*t", os.time()) end }
	env._ENV = env
	env._G = env
	-- Remove dangerous global functions from the sandbox
	env.jit = nil
	env.newproxy = nil
	env.getfenv = nil
	env.setfenv = nil
	env.load = nil
	env.loadstring = nil
	env.dofile = nil
	env.require = nil
	env.io = nil
	env.package = nil
	env.debug = nil

	-- Load user code WITH the environment (Lua 5.3)
	local f, load_err = load(__lc_code, "code", "t", env)
	if not f then return __lc_jsonenc({ error = true, msg = "Compile error: " .. tostring(load_err) }) end

	local ok, err = pcall(f)
	if not ok then return __lc_jsonenc({ error = true, msg = tostring(err) }) end
	if type(env.port) ~= "table" then return __lc_jsonenc({ error = true, msg = "Ports set are invalid." }) end

	-- Coerce ports to booleans and copy back the outputs
	out.port = {}
	for _, p in ipairs({ "a","b","c","d" }) do
		out.port[p] = env.port[p] and true or false
	end
	out.mem = env.mem or {}
	return __lc_jsonenc(out)
`;

	// Provide the JS utilities to Lua
	lua.lua_pushcfunction(L, (ll) => {
		// __lc_load_json(str) -> table
		const s = lua.lua_tojsstring(ll, 1);
		try {
			const obj = JSON.parse(s);
			return pushJsValue(ll, obj);
		} catch (errrr) {
			lua.lua_pushnil(ll);
			return 1;
		}
	});
	lua.lua_setglobal(L, "__lc_load_json");

	// __lc_shallow(t)
	lua.lua_pushcfunction(L, (ll) => {
		lua.lua_newtable(ll);
		if (lua.lua_istable(ll, 1)) {
			lua.lua_pushnil(ll);
			while (lua.lua_next(ll, 1) !== 0) {
				lua.lua_pushvalue(ll, -2);
				lua.lua_pushvalue(ll, -2);
				lua.lua_rawset(ll, -5);
				lua.lua_pop(ll, 1);
			}
		}
		return 1;
	});
	lua.lua_setglobal(L, "__lc_shallow");

	// parse wrapper & run (luaL_dostring expects a luastring in this build)
	const status = lauxlib.luaL_dostring(L, to_luastring(wrapper));
	if (status !== 0) {
		const errmsg = lua.lua_tojsstring(L, -1);
		lua.lua_pop(L, 1);
		return { error: true, msg: "Internal: " + errmsg };
	}

	// the wrapper returns a JSON string (serialization via Lua, per jsValueFromStack)
	const json = lua.lua_tojsstring(L, -1);
	lua.lua_pop(L, 1);
	if (json === null || json === undefined || json === "") return { error: true, msg: "No result" };

	let out;
	try { out = JSON.parse(json); } catch (e) { return { error: true, msg: "Invalid JSON: " + json }; }

	// Apply outputs
	if (out.port) vports = out.port;

	// Apply timers
	if (typeof out.interrupt === "number") {
		timers.push({ when: clock + out.interrupt, iid: null });
	}

	return {
		error: !!out.error,
		msg: out.msg,
		port: out.port,
		interrupt: out.interrupt,
		ds: out.ds,
		printed: out.printed,
		mem: out.mem,
	};
}

function onError(msg) {
	// Like the mod, an error resets the code (and shows the error).
	// Notify the UI; it keeps the code visible but flags the burned-out state.
	const errmsg = msg || "Error";
	postMessage({ type: "program_error", msg: errmsg });
}

// ---------------------------------------------------------------------------
// JS <-> Lua conversions (serializable values)
// ---------------------------------------------------------------------------
function pushJsValue(ll, v) {
	if (v === null || v === undefined) { lua.lua_pushnil(ll); return 1; }
	if (typeof v === "boolean") { lua.lua_pushboolean(ll, v ? 1 : 0); return 1; }
	if (typeof v === "number") { lua.lua_pushnumber(ll, v); return 1; }
	if (typeof v === "string") { lua.lua_pushliteral(ll, v); return 1; }
	if (Array.isArray(v)) {
		lua.lua_newtable(ll);
		for (let i = 0; i < v.length; i++) {
			lua.lua_pushnumber(ll, i + 1);
			pushJsValue(ll, v[i]);
			lua.lua_settable(ll, -3);
		}
		return 1;
	}
	if (typeof v === "object") {
		lua.lua_newtable(ll);
		for (const k in v) {
			lua.lua_pushliteral(ll, k);
			pushJsValue(ll, v[k]);
			lua.lua_settable(ll, -3);
		}
		return 1;
	}
	lua.lua_pushnil(ll);
	return 1;
}

function setGlobal(name, value) {
	if (typeof value === "string") {
		lua.lua_pushliteral(L, value);
	} else if (typeof value === "number") {
		lua.lua_pushnumber(L, value);
	} else if (typeof value === "boolean") {
		lua.lua_pushboolean(L, value ? 1 : 0);
	} else {
		lua.lua_pushnil(L);
	}
	lua.lua_setglobal(L, name);
}