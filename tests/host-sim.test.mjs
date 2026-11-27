/**
 * Host-simulation tests for the trash-bin sequence.
 *
 * `ctx` is a hand-written fake that mirrors the shapes the Host half touches
 * (webServer.register / workspaceRegistry / SessionStore and AgentRegistry
 * stores / sessionPersistence.list + root). No real DSH process is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { apply, name as pluginName, inject } from "../lib/index.js";

const ROUTE = "/dsh-session-trash-bin";

/** Build a fake DSH host over a throwaway sessions root. */
async function makeHost({ sessions: sessionSpecs = [], liveSessions = [], liveAgents = [], archived = [], pinned = [] }) {
	const base = await mkdtemp(path.join(tmpdir(), "dsr-"));
	const sessionsRoot = path.join(base, "sessions");
	const snapshots = [];
	const sessionIds = sessionSpecs.map((spec) => spec.id);
	for (const spec of sessionSpecs) {
		const dir = path.join(sessionsRoot, "slug", spec.id);
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${spec.id}.jsonl`);
		await writeFile(file, '{"type":"session.start"}\n', "utf8");
		snapshots.push({
			header: { id: spec.id, title: spec.title ?? null, cwd: base },
			location: { path: file },
			sizeBytes: 23
		});
	}

	const calls = [];
	const emitted = [];
	const warnings = [];
	let state = { archivedSessionIds: [...archived], pinnedSessionIds: [...pinned] };

	const sessionStore = new Map(liveSessions.map((id) => [id, { id, session: { id } }]));
	const agentStore = new Map(liveAgents.map((id) => [id, { id, agent: { id } }]));

	const sessions = {
		store: sessionStore,
		get: (id) => sessionStore.get(id)?.session,
		detachEntered(entry) {
			calls.push(`sessions.detachEntered:${entry.id}`);
			sessionStore.delete(entry.id);
		}
	};
	const agents = {
		store: agentStore,
		get: (id) => agentStore.get(id)?.agent,
		detachEntered(entry) {
			calls.push(`agents.detachEntered:${entry.id}`);
			agentStore.delete(entry.id);
		}
	};

	const workspace = {
		id: "workspace-1",
		sessionIds: [...sessionIds],
		async detachSession(id) {
			calls.push(`detach:${id}`);
			this.sessionIds = this.sessionIds.filter((candidate) => candidate !== id);
		},
		async attachSession(id) {
			calls.push(`attach:${id}`);
			if (!this.sessionIds.includes(id)) this.sessionIds.push(id);
		}
	};

	const registry = {
		async sessionKnown(id) {
			return snapshots.some((snapshot) => snapshot.header.id === id) || workspace.sessionIds.includes(id);
		},
		async enqueueOperation(operation) {
			calls.push("enqueueOperation");
			return await operation();
		},
		list() {
			return [workspace];
		},
		requireState() {
			return { ...state, archivedSessionIds: [...state.archivedSessionIds], pinnedSessionIds: [...state.pinnedSessionIds] };
		},
		async setState(next) {
			calls.push("setState");
			state = { ...next };
		},
		async archiveSession(id) {
			calls.push(`archive:${id}`);
			if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds.push(id);
		},
		async pinSession(id) {
			calls.push(`pin:${id}`);
			if (!state.pinnedSessionIds.includes(id)) state.pinnedSessionIds.push(id);
		}
	};

	const services = {
		sessions,
		agents,
		sessionPersistence: { root: sessionsRoot, list: async () => snapshots },
		sessionProjectionCache: {
			table: {
				deleted: [],
				async delete(id) {
					this.deleted.push(id);
					calls.push(`projection.delete:${id}`);
				}
			}
		}
	};

	let handler;
	const ctx = {
		effect(fn) {
			const result = fn();
			return typeof result === "function" ? result : () => void 0;
		},
		webServer: {
			register(route) {
				handler = route.handler;
				calls.push(`route:${route.kind}:${route.path}`);
				return () => void 0;
			}
		},
		workspaceRegistry: registry,
		sessionPersistence: services.sessionPersistence,
		get: (service) => services[service],
		emit: (event, id) => emitted.push({ event, id }),
		logger: {
			info: () => void 0,
			warn: (text) => warnings.push(text)
		}
	};

	for (const id of liveAgents) {
		const agent = agentStore.get(id).agent;
		agent.cancel = (cause) => calls.push(`cancel:${id}:${cause.kind}`);
		agent.whenIdle = async () => {
			calls.push(`whenIdle:${id}`);
		};
		agent.scope = {
			dispose: async () => {
				calls.push(`scope.dispose:${id}`);
			}
		};
	}

	return {
		base,
		sessionsRoot,
		trashRoot: `${sessionsRoot}-trash`,
		snapshots,
		services,
		workspace,
		calls,
		emitted,
		warnings,
		state: () => state,
		handler: () => handler,
		ctx
	};
}

function makeRequest({ method, url, body, headers = {}, remoteAddress = "127.0.0.1" }) {
	const payload = body === void 0 ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	return {
		method,
		url,
		headers,
		socket: { remoteAddress },
		async *[Symbol.asyncIterator]() {
			for (const chunk of payload) yield chunk;
		}
	};
}

function makeResponse() {
	const chunks = [];
	return {
		statusCode: void 0,
		headers: void 0,
		body: () => Buffer.concat(chunks).toString("utf8"),
		json() {
			return JSON.parse(this.body());
		},
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
		},
		end(chunk) {
			if (chunk !== void 0) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
		}
	};
}

async function call(host, request) {
	const response = makeResponse();
	await host.handler()(makeRequest({ headers: { host: "127.0.0.1:3593" }, ...request }), response);
	return response;
}

const post = (host, action, body, extra = {}) =>
	call(host, {
		method: "POST",
		url: `${ROUTE}/${action}`,
		body,
		headers: { host: "127.0.0.1:3593", ...extra.headers },
		remoteAddress: extra.remoteAddress
	});

async function trashEntries(host) {
	return (await readdir(host.trashRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
}

test("plugin declares the services the trash-bin sequence needs", () => {
	assert.equal(pluginName, "dsh-session-trash-bin");
	assert.deepEqual(inject, ["webServer", "workspaceRegistry", "sessionPersistence"]);
});

test("apply() registers one prefixed route", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);
	assert.deepEqual(host.calls.filter((entry) => entry.startsWith("route:")), [`route:prefix:${ROUTE}`]);
});

test("deleting a live session stops it, detaches both registries, then moves it to the trash", async () => {
	const host = await makeHost({
		sessions: [{ id: "session-live", title: "Live one" }],
		liveSessions: ["session-live"],
		liveAgents: ["session-live"]
	});
	apply(host.ctx);

	const payload = (await post(host, "delete", { sessionId: "session-live" })).json();

	assert.equal(payload.ok, true);
	assert.equal(payload.sessionId, "session-live");
	assert.equal(payload.title, "Live one");
	assert.equal(payload.wasLive, true);
	assert.match(payload.trashName, /__session-live$/);

	const ordered = host.calls.filter((entry) => !entry.startsWith("route:"));
	const cancelAt = ordered.indexOf("cancel:session-live:disposed");
	const whenIdleAt = ordered.indexOf("whenIdle:session-live");
	const detachSessionAt = ordered.indexOf("sessions.detachEntered:session-live");
	const detachAgentAt = ordered.indexOf("agents.detachEntered:session-live");
	const disposeAt = ordered.indexOf("scope.dispose:session-live");
	assert.ok(cancelAt >= 0 && whenIdleAt > cancelAt);
	assert.ok(detachSessionAt > whenIdleAt && detachAgentAt > detachSessionAt && disposeAt > detachAgentAt);
	assert.deepEqual(host.emitted, []);

	const entries = await trashEntries(host);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].name, payload.trashName);
	await assert.rejects(() => stat(path.join(host.sessionsRoot, "slug", "session-live")));
	const meta = JSON.parse(await readFile(path.join(host.trashRoot, `${payload.trashName}.json`), "utf8"));
	assert.equal(meta.sessionId, "session-live");
	assert.equal(meta.project, "slug");
	assert.equal(meta.dirName, "session-live");
	assert.deepEqual(meta.workspaceIds, ["workspace-1"]);
});

test("deleting an idle session still trashes it and broadcasts exactly one removal", async () => {
	const host = await makeHost({ sessions: [{ id: "session-idle" }] });
	apply(host.ctx);

	const payload = (await post(host, "delete", { sessionId: "session-idle" })).json();

	assert.equal(payload.ok, true);
	assert.equal(payload.wasLive, false);
	assert.equal((await trashEntries(host)).length, 1);
	assert.deepEqual(host.emitted, [{ event: "api-session/removed", id: "session-idle" }]);
	assert.equal(host.calls.some((entry) => entry.startsWith("cancel:")), false);
});

test("archived and pinned state is captured and restored with the session", async () => {
	const host = await makeHost({
		sessions: [{ id: "session-archived" }],
		archived: ["session-archived", "session-keep"],
		pinned: ["session-archived"]
	});
	apply(host.ctx);

	const deleted = (await post(host, "delete", { sessionId: "session-archived" })).json();
	assert.deepEqual(host.state().archivedSessionIds, ["session-keep"]);
	assert.deepEqual(host.state().pinnedSessionIds, []);

	const restored = (await post(host, "restore", { name: deleted.trashName })).json();
	assert.equal(restored.ok, true);
	assert.equal(host.calls.includes("attach:session-archived"), true);
	assert.equal(host.state().archivedSessionIds.includes("session-archived"), true);
	await stat(path.join(host.sessionsRoot, "slug", "session-archived"));
});

test("GET /trash lists entries with restore metadata", async () => {
	const host = await makeHost({ sessions: [{ id: "session-a", title: "A" }] });
	apply(host.ctx);
	await post(host, "delete", { sessionId: "session-a" });

	const payload = (await call(host, { method: "GET", url: `${ROUTE}/trash` })).json();
	assert.equal(payload.ok, true);
	assert.equal(payload.entries.length, 1);
	assert.equal(payload.entries[0].sessionId, "session-a");
	assert.equal(payload.entries[0].title, "A");
	assert.equal(payload.entries[0].legacy, false);
	assert.equal(payload.entries[0].restorable, true);
});

test("restore moves the directory back, removes the sidecar, and prunes an empty trash", async () => {
	const host = await makeHost({ sessions: [{ id: "session-restore", title: "R" }] });
	apply(host.ctx);
	const deleted = (await post(host, "delete", { sessionId: "session-restore" })).json();

	const restored = (await post(host, "restore", { name: deleted.trashName })).json();
	assert.equal(restored.ok, true);
	assert.equal(restored.sessionId, "session-restore");
	assert.equal(host.calls.includes("attach:session-restore"), true);
	await stat(path.join(host.sessionsRoot, "slug", "session-restore"));
	await assert.rejects(() => stat(host.trashRoot));
});

test("purge permanently deletes one entry", async () => {
	const host = await makeHost({ sessions: [{ id: "session-purge" }] });
	apply(host.ctx);
	const deleted = (await post(host, "delete", { sessionId: "session-purge" })).json();

	const purged = (await post(host, "purge", { name: deleted.trashName })).json();
	assert.equal(purged.ok, true);
	await assert.rejects(() => stat(host.trashRoot));
	await assert.rejects(() => stat(path.join(host.sessionsRoot, "slug", "session-purge")));
});

test("empty-trash removes every entry and reports the count", async () => {
	const host = await makeHost({ sessions: [{ id: "session-1" }, { id: "session-2" }] });
	apply(host.ctx);
	await post(host, "delete", { sessionId: "session-1" });
	await post(host, "delete", { sessionId: "session-2" });

	const emptied = (await post(host, "empty-trash", {})).json();
	assert.equal(emptied.ok, true);
	assert.equal(emptied.removed, 2);
	await assert.rejects(() => stat(host.trashRoot));
});

test("GET /trash and empty-trash handle a missing trash folder", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);
	const listed = (await call(host, { method: "GET", url: `${ROUTE}/trash` })).json();
	assert.deepEqual(listed.entries, []);
	const emptied = (await post(host, "empty-trash", {})).json();
	assert.equal(emptied.ok, true);
	assert.equal(emptied.removed, 0);
});

test("restore recreates a missing project directory", async () => {
	const host = await makeHost({ sessions: [{ id: "session-moved" }] });
	apply(host.ctx);
	const deleted = (await post(host, "delete", { sessionId: "session-moved" })).json();
	await rm(path.join(host.sessionsRoot, "slug"), { recursive: true, force: true });

	const restored = (await post(host, "restore", { name: deleted.trashName })).json();
	assert.equal(restored.ok, true);
	await stat(path.join(host.sessionsRoot, "slug", "session-moved"));
});

test("a legacy trash entry is listed but cannot be restored", async () => {
	const host = await makeHost({ sessions: [] });
	await mkdir(path.join(host.trashRoot, "2026-01-01T00-00-00-000Z__session-legacy"), { recursive: true });
	apply(host.ctx);

	const listed = (await call(host, { method: "GET", url: `${ROUTE}/trash` })).json();
	assert.equal(listed.entries.length, 1);
	assert.equal(listed.entries[0].legacy, true);
	assert.equal(listed.entries[0].restorable, false);

	const refused = (await post(host, "restore", { name: listed.entries[0].name })).json();
	assert.equal(refused.ok, false);
	assert.match(refused.error, /restore metadata/);

	const purged = (await post(host, "purge", { name: listed.entries[0].name })).json();
	assert.equal(purged.ok, true);
});

test("traversal-shaped trash names are refused", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);
	const restored = (await post(host, "restore", { name: "../outside" })).json();
	assert.equal(restored.ok, false);
	const purged = (await post(host, "purge", { name: "../../outside" })).json();
	assert.equal(purged.ok, false);
});

test("an unknown session is refused without touching the filesystem", async () => {
	const host = await makeHost({ sessions: [{ id: "session-known" }] });
	apply(host.ctx);
	const payload = (await post(host, "delete", { sessionId: "session-nope" })).json();
	assert.equal(payload.ok, false);
	assert.match(payload.error, /no such session/);
	await assert.rejects(() => stat(host.trashRoot));
});

test("a missing sessionId is rejected", async () => {
	const host = await makeHost({ sessions: [] });
	apply(host.ctx);
	const payload = (await post(host, "delete", {})).json();
	assert.equal(payload.ok, false);
	assert.match(payload.error, /missing sessionId/);
});

test("destructive POSTs from a foreign origin or non-loopback peer are rejected", async () => {
	const host = await makeHost({ sessions: [{ id: "session-csrf" }] });
	apply(host.ctx);

	const foreign = await post(host, "delete", { sessionId: "session-csrf" }, { headers: { origin: "https://evil.example" } });
	assert.equal(foreign.statusCode, 403);
	const lan = await post(host, "delete", { sessionId: "session-csrf" }, { remoteAddress: "192.168.1.20" });
	assert.equal(lan.statusCode, 403);
	await assert.rejects(() => stat(host.trashRoot));
});

test("GET / and /diag expose the service and hooks", async () => {
	const host = await makeHost({ sessions: [], liveSessions: ["session-x"], liveAgents: ["session-y"] });
	apply(host.ctx);

	const root = (await call(host, { method: "GET", url: ROUTE })).json();
	assert.equal(root.service, "dsh-session-trash-bin");
	assert.equal(root.revision, "0.2.0");

	const diag = (await call(host, { method: "GET", url: `${ROUTE}/diag` })).json();
	assert.deepEqual(diag.supports, { sessionsDetachEntered: true, agentsDetachEntered: true });
	assert.deepEqual(diag.live, { sessions: ["session-x"], agents: ["session-y"] });

	const put = await call(host, { method: "PUT", url: `${ROUTE}/delete` });
	assert.equal(put.statusCode, 405);
});

test.after(async () => {
	await rm(path.join(tmpdir(), "dsr-nonexistent"), { recursive: true, force: true });
});
