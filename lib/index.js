/**
 * dsh-session-trash-bin — Host half.
 *
 * A trash bin for DeepSeek Harness conversations, based on
 * TuWeiZhi/dsh-session-delete (MIT).
 *
 * Deleting a session:
 *   1. cancels a still-running Agent and waits (bounded) for idle;
 *   2. detaches the live session/agent entries so persistence flushes, releases
 *      its write lease, closes the file handle, and the official session
 *      controller broadcasts `api-session/removed`;
 *   3. drops workspace membership plus archived/pinned state — but records that
 *      state in a sidecar first so a later restore can put it back;
 *   4. renames the session directory into `<sessions-root>-trash/`.
 *
 * The trash is a plain folder beside the sessions root. Its entries can be
 * listed, restored, permanently deleted one by one, or all emptied. Every
 * destructive route is loopback + same-origin fenced, and every path is derived
 * from a validated id or a validated trash entry name — never from a
 * client-supplied filesystem path.
 *
 * Zero dependencies: only `node:fs`, `node:path`, and `node:os`.
 *
 * Routes:
 *   GET  /dsh-session-trash-bin                 liveness
 *   GET  /dsh-session-trash-bin/list            session inventory (debug)
 *   GET  /dsh-session-trash-bin/trash           trash entries + trash root
 *   GET  /dsh-session-trash-bin/diag            revision + internal hooks
 *   POST /dsh-session-trash-bin/delete          { sessionId }
 *   POST /dsh-session-trash-bin/restore         { name }
 *   POST /dsh-session-trash-bin/purge           { name }
 *   POST /dsh-session-trash-bin/empty-trash     {}
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const name = "dsh-session-trash-bin";
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

const ROUTE = "/dsh-session-trash-bin";
const BODY_LIMIT = 64 * 1024;
/** Bumped per release; `/diag` reports it so you can tell which code is loaded. */
const REVISION = "0.2.0";
/** Prefix written into every trash entry name. */
const TRASH_STAMP = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Loopback is the only peer allowed to run a destructive POST (remote access proxies in). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store"
	});
	res.end(body);
}

async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body is not valid JSON");
	}
}

const message = (error) => (error instanceof Error ? error.message : String(error));

/** Resolve a session's on-disk directory: `<root>/<projectSlug>/<id>/`. */
async function locateSession(ctx, sessionId) {
	const snapshots = await ctx.sessionPersistence.list();
	for (const snapshot of snapshots) {
		if (snapshot.header.id !== sessionId) continue;
		const file = snapshot.location?.path;
		if (typeof file !== "string" || file === "") return { snapshot, dir: void 0 };
		const dir = path.dirname(file);
		return { snapshot, dir: path.basename(dir) === sessionId ? dir : void 0 };
	}
	return { snapshot: void 0, dir: void 0 };
}

/** Wait for a promise that may hang; on timeout carry on — cleanup must not block deletion. */
function settle(promise, ms) {
	if (typeof promise?.then !== "function") return Promise.resolve();
	return Promise.race([
		Promise.resolve(promise).catch(() => void 0),
		new Promise((resolve) => setTimeout(resolve, ms).unref?.())
	]);
}

/** SessionStore and AgentRegistry both keep `store: Map<id, entry>` of entered entries. */
function storeOf(service) {
	const store = service?.store;
	return store instanceof Map ? store : void 0;
}

/**
 * Drop the in-process entry the same way the official shutdown path does:
 * `detachEntered()` emits `session/disposed` / `agent/disposed`, which removes
 * the row on the client and closes the persistence write handle.
 * @returns whether a `disposed` event was actually emitted by the store.
 */
function detachEntered(service, id) {
	const store = storeOf(service);
	if (store === void 0) return false;
	const entry = store.get(id);
	if (entry === void 0) return false;
	if (typeof service.detachEntered === "function") {
		try {
			service.detachEntered(entry);
		} catch (error) {
			service.ctx?.logger?.warn?.(`${name}: detachEntered failed: ${message(error)}`);
		}
		if (!store.has(id)) return true;
	}
	/* Cross-version fallback: at least drop the entry. */
	store.delete(id);
	return false;
}

/** Make a still-running agent stop: abort only, never destroy. */
async function stopAgent(agent) {
	try {
		agent.cancel?.({ kind: "disposed" });
	} catch {
		/* already tearing down — fine */
	}
	await settle(agent.whenIdle?.(), 5000);
}

/** Rename with retries for Windows handles that are still being released. */
async function renameWithRetry(from, to) {
	let last;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			last = error;
			const code = error?.code;
			if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "ENOTEMPTY") throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error(
		`session directory is still in use, cannot move it (${last?.code ?? "unknown"}): ${message(last)}`
	);
}

/** The sidecar file that stores restore data next to one trash directory. */
function metaPathOf(trashDir) {
	return `${trashDir}.json`;
}

/** Write restore metadata atomically (small JSON, owner-only). */
async function writeTrashMeta(trashDir, meta) {
	const target = metaPathOf(trashDir);
	const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(temporary, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
}

/** Read one sidecar, or undefined for a legacy / unreadable entry. */
async function readTrashMeta(trashDir) {
	try {
		const raw = await fs.readFile(metaPathOf(trashDir), "utf8");
		const meta = JSON.parse(raw);
		if (meta === null || typeof meta !== "object") return void 0;
		if (typeof meta.sessionId !== "string" || typeof meta.project !== "string" || typeof meta.dirName !== "string") {
			return void 0;
		}
		return meta;
	} catch {
		return void 0;
	}
}

/** Require an existing real directory (a symlink is refused). */
async function requireDirectory(pathname) {
	const stats = await fs.lstat(pathname);
	if (!stats.isDirectory()) throw new Error("the trash location is not a directory");
}

/** Whether `child` is a strict descendant of `parent` (both absolute). */
function isInside(parent, child) {
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The session-persistence root, or undefined when it cannot be resolved. */
async function sessionsRoot(ctx) {
	const persistence = ctx.sessionPersistence;
	const candidates = [persistence?.root, persistence?.config?.root];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate !== "") return path.resolve(candidate);
	}
	try {
		const snapshots = await persistence.list();
		for (const snapshot of snapshots) {
			const file = snapshot.location?.path;
			if (typeof file !== "string" || file === "") continue;
			const dir = path.dirname(file);
			const project = path.dirname(dir);
			if (project.startsWith("--") || path.basename(project) === "_no-cwd") return path.dirname(project);
		}
	} catch {
		/* fall through to the home default */
	}
	const home = process.env.DSH_HOME || path.join(homedir(), ".dsh");
	return path.join(home, "sessions");
}

/** Remove a directory only when it is empty; ignore every failure. */
async function pruneEmptyDirectory(directory) {
	try {
		await fs.rmdir(directory);
	} catch {
		/* not empty, already gone, or not removable */
	}
}

/** One validated trash entry name; no separators, no traversal. */
function validTrashName(value) {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 240
		&& value !== "."
		&& value !== ".."
		&& !value.includes("/")
		&& !value.includes("\\")
		&& !value.includes("\0");
}

/** A safe single path segment. */
function validSegment(value) {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 240
		&& value !== "."
		&& value !== ".."
		&& path.basename(value) === value;
}

/**
 * Move one session into the trash and record what a restore needs.
 * @returns the trash entry name.
 */
async function moveSessionToTrash(ctx, sessionId, dir, snapshot, workspaceState, warnings) {
	const root = path.dirname(path.dirname(dir));
	const trashRoot = `${root}-trash`;
	await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
	await requireDirectory(trashRoot);
	const trashName = `${TRASH_STAMP()}-${Math.random().toString(36).slice(2, 8)}__${path.basename(dir)}`;
	const trashDir = path.join(trashRoot, trashName);
	await renameWithRetry(dir, trashDir);
	const meta = {
		version: 1,
		sessionId,
		title: snapshot?.header?.title ?? null,
		deletedAt: new Date().toISOString(),
		project: path.basename(path.dirname(dir)),
		dirName: path.basename(dir),
		sizeBytes: snapshot?.sizeBytes ?? null,
		workspaceIds: workspaceState.workspaceIds,
		workspacePaths: workspaceState.workspacePaths,
		archived: workspaceState.archived,
		pinned: workspaceState.pinned
	};
	try {
		await writeTrashMeta(trashDir, meta);
		return { trashName, restorable: true };
	} catch (error) {
		warnings.push(
			`The session moved to the trash, but its restore metadata could not be written (${message(error)}). It can only be deleted permanently.`
		);
		return { trashName, restorable: false };
	}
}

/** Workspace membership and flags captured before deletion. */
function captureWorkspaceState(registry, sessionId) {
	const workspaceIds = [];
	const workspacePaths = [];
	try {
		for (const entity of registry.list()) {
			if (!entity.sessionIds.includes(sessionId)) continue;
			workspaceIds.push(entity.id);
			if (typeof entity.path === "string") workspacePaths.push(entity.path);
		}
	} catch {
		/* an unreadable registry only loses the restore hint */
	}
	let archived = false;
	let pinned = false;
	try {
		const state = registry.requireState();
		archived = state.archivedSessionIds.includes(sessionId);
		pinned = state.pinnedSessionIds.includes(sessionId);
	} catch {
		/* flags stay false */
	}
	return { workspaceIds, workspacePaths, archived, pinned };
}

async function deleteSession(ctx, sessionId) {
	if (typeof sessionId !== "string" || sessionId.trim() === "") throw new Error("missing sessionId");

	const registry = ctx.workspaceRegistry;
	if (!(await registry.sessionKnown(sessionId))) throw new Error("no such session — it may have been deleted already");

	const { snapshot, dir } = await locateSession(ctx, sessionId);
	if (snapshot?.location?.path !== void 0 && dir === void 0) {
		throw new Error("the stored session directory layout is not recognized; deletion refused");
	}
	const workspaceState = captureWorkspaceState(registry, sessionId);

	const sessions = ctx.get?.("sessions");
	const agents = ctx.get?.("agents");
	const liveSession = sessions?.get?.(sessionId);
	const liveAgent = agents?.get?.(sessionId);
	let disposedByStore = false;
	const warnings = [];

	const result = await registry.enqueueOperation(async () => {
		// 0) Stop and detach the live session so persistence closes its handle.
		if (liveAgent !== void 0) await stopAgent(liveAgent);
		disposedByStore = detachEntered(sessions, sessionId);
		detachEntered(agents, sessionId);
		await settle(liveAgent?.scope?.dispose?.(), 3000);

		// 1) Bookkeeping: detach from every workspace, clear archived/pinned leftovers.
		//    A failed cleanup is reported but must not stop the move: the trash bin
		//    is what makes the session disappear, and the sidecar already has the state.
		try {
			for (const entity of registry.list()) {
				if (!entity.sessionIds.includes(sessionId)) continue;
				try {
					await entity.detachSession(sessionId);
				} catch (error) {
					warnings.push(`The session could not be detached from a workspace (${message(error)}).`);
				}
			}
			const state = registry.requireState();
			const archivedSessionIds = state.archivedSessionIds.filter((id) => id !== sessionId);
			const pinnedSessionIds = state.pinnedSessionIds.filter((id) => id !== sessionId);
			if (
				archivedSessionIds.length !== state.archivedSessionIds.length ||
				pinnedSessionIds.length !== state.pinnedSessionIds.length
			) {
				await registry.setState({ ...state, archivedSessionIds, pinnedSessionIds });
			}
		} catch (error) {
			warnings.push(`The workspace bookkeeping could not be fully cleared (${message(error)}).`);
		}

		// 2) Move into the trash bin.
		let trashName = null;
		let restorable = false;
		if (dir !== void 0) {
			const moved = await moveSessionToTrash(ctx, sessionId, dir, snapshot, workspaceState, warnings);
			trashName = moved.trashName;
			restorable = moved.restorable;
		}

		// 3) Projection cache, best effort: a leftover row cannot resurrect the session.
		try {
			await ctx.get?.("sessionProjectionCache")?.table?.delete?.(sessionId);
		} catch {
			/* purely derived data */
		}

		for (const warning of warnings) ctx.logger?.warn?.(`${name}: ${warning}`);
		ctx.logger?.info?.(
			`${name}: moved session ${sessionId} to the trash bin (${liveSession !== void 0 || liveAgent !== void 0 ? "live" : "idle"}) → ${trashName ?? "(no file on disk)"}`
		);
		return {
			ok: true,
			sessionId,
			title: snapshot?.header?.title ?? null,
			trashName: restorable ? trashName : null,
			trashEntry: trashName,
			wasLive: liveSession !== void 0 || liveAgent !== void 0,
			warnings
		};
	});

	// 4) A detached live entry already emitted `session/disposed`; a cold entry needs one synthetic removal.
	if (!disposedByStore) ctx.emit("api-session/removed", sessionId);
	return result;
}

/** Every entry in the trash bin, newest first. */
async function listTrash(ctx) {
	const root = await sessionsRoot(ctx);
	const trashRoot = `${root}-trash`;
	try {
		await requireDirectory(trashRoot);
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, trashRoot, entries: [] };
		throw error;
	}
	let entries;
	try {
		entries = await fs.readdir(trashRoot, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, trashRoot, entries: [] };
		throw error;
	}
	const items = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const trashDir = path.join(trashRoot, entry.name);
		const meta = await readTrashMeta(trashDir);
		const separator = entry.name.indexOf("__");
		const derivedId = separator < 0 ? entry.name : entry.name.slice(separator + 2);
		items.push({
			name: entry.name,
			sessionId: meta?.sessionId ?? derivedId,
			title: meta?.title ?? null,
			deletedAt: meta?.deletedAt ?? null,
			sizeBytes: meta?.sizeBytes ?? null,
			legacy: meta === void 0,
			restorable: meta !== void 0
		});
	}
	items.sort((a, b) => String(b.deletedAt ?? b.name).localeCompare(String(a.deletedAt ?? a.name)));
	return { ok: true, trashRoot, entries: items };
}

/** Restore one trash entry to its original project directory. */
async function restoreTrash(ctx, name) {
	if (!validTrashName(name)) throw new Error("missing or invalid trash entry name");
	const root = await sessionsRoot(ctx);
	const trashRoot = `${root}-trash`;
	const trashDir = path.join(trashRoot, name);
	if (path.dirname(trashDir) !== trashRoot) throw new Error("invalid trash entry name");
	await requireDirectory(trashRoot);
	await requireDirectory(trashDir);
	const meta = await readTrashMeta(trashDir);
	if (meta === void 0) {
		throw new Error("this trash entry has no restore metadata; move its directory back by hand or delete it permanently");
	}
	if (!validSegment(meta.project) || !validSegment(meta.dirName)) throw new Error("the restore metadata is invalid");
	const target = path.join(root, meta.project, meta.dirName);
	if (!isInside(root, target)) throw new Error("the restore target escapes the sessions root");
	if (await fs.stat(target).then(() => true, () => false)) {
		throw new Error("the original session directory already exists; restore refused");
	}
	const existing = typeof ctx.sessionPersistence.stat === "function"
		? await ctx.sessionPersistence.stat(meta.sessionId).catch(() => void 0)
		: void 0;
	if (existing !== void 0) throw new Error("a session with this id already exists; restore refused");
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	const realRoot = await fs.realpath(root);
	const realParent = await fs.realpath(path.dirname(target));
	if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
		throw new Error("the restore target escapes the sessions root");
	}
	await renameWithRetry(trashDir, target);
	await fs.rm(metaPathOf(trashDir), { force: true });

	const warnings = [];
	const registry = ctx.workspaceRegistry;
	const entities = registry.list();
	const workspaceIds = Array.isArray(meta.workspaceIds) ? meta.workspaceIds : [];
	for (const workspaceId of workspaceIds) {
		const entity = entities.find((candidate) => candidate.id === workspaceId);
		if (entity === void 0) continue;
		try {
			await entity.attachSession(meta.sessionId);
		} catch (error) {
			warnings.push(`The session was restored, but it could not be reattached to its workspace (${message(error)}).`);
		}
	}
	// A workspace may have been removed and recreated under a new id; try the
	// recorded canonical path when the id no longer resolves.
	for (const workspacePath of Array.isArray(meta.workspacePaths) ? meta.workspacePaths : []) {
		if (typeof workspacePath !== "string" || workspacePath === "") continue;
		try {
			const entity = await registry.resolveByPath(workspacePath);
			if (entity !== void 0) await entity.attachSession(meta.sessionId);
		} catch {
			/* the id-based pass already reported; path is only a fallback */
		}
	}
	if (meta.archived === true) {
		try {
			await registry.archiveSession(meta.sessionId);
		} catch (error) {
			warnings.push(`The session was restored, but its archived mark could not be restored (${message(error)}).`);
		}
	} else if (meta.pinned === true) {
		try {
			await registry.pinSession(meta.sessionId);
		} catch (error) {
			warnings.push(`The session was restored, but its pinned mark could not be restored (${message(error)}).`);
		}
	}
	await pruneEmptyDirectory(trashRoot);
	for (const warning of warnings) ctx.logger?.warn?.(`${name}: ${warning}`);
	return { ok: true, sessionId: meta.sessionId, restoredTo: target, warnings };
}

/** Permanently delete one trash entry. */
async function purgeTrash(ctx, name) {
	if (!validTrashName(name)) throw new Error("missing or invalid trash entry name");
	const root = await sessionsRoot(ctx);
	const trashRoot = `${root}-trash`;
	const trashDir = path.join(trashRoot, name);
	if (path.dirname(trashDir) !== trashRoot) throw new Error("invalid trash entry name");
	await requireDirectory(trashRoot);
	await requireDirectory(trashDir);
	await fs.rm(trashDir, { recursive: true, force: true });
	await fs.rm(metaPathOf(trashDir), { force: true });
	await pruneEmptyDirectory(trashRoot);
	return { ok: true, name };
}

/** Permanently delete every trash entry. */
async function emptyTrash(ctx) {
	const root = await sessionsRoot(ctx);
	if (root === path.parse(root).root) throw new Error("refusing to empty a trash folder beside a filesystem root");
	const trashRoot = `${root}-trash`;
	if (trashRoot === root) throw new Error("invalid trash location");
	try {
		await requireDirectory(trashRoot);
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, removed: 0 };
		throw error;
	}
	let entries = [];
	try {
		entries = await fs.readdir(trashRoot, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, removed: 0 };
		throw error;
	}
	const removed = entries.filter((entry) => entry.isDirectory()).length;
	await fs.rm(trashRoot, { recursive: true, force: true });
	return { ok: true, removed };
}

async function listSessions(ctx) {
	const snapshots = await ctx.sessionPersistence.list();
	const registry = ctx.workspaceRegistry;
	const state = registry.requireState();
	const workspaceOf = new Map();
	for (const entity of registry.list()) for (const id of entity.sessionIds) workspaceOf.set(id, entity.path);
	const archived = new Set(state.archivedSessionIds);
	const pinned = new Set(state.pinnedSessionIds);
	return snapshots.map((snapshot) => ({
		id: snapshot.header.id,
		title: snapshot.header.title ?? null,
		cwd: snapshot.header.cwd ?? null,
		sizeBytes: snapshot.sizeBytes,
		workspace: workspaceOf.get(snapshot.header.id) ?? null,
		archived: archived.has(snapshot.header.id),
		pinned: pinned.has(snapshot.header.id),
		path: snapshot.location?.path ?? null
	}));
}

/** Reject destructive requests that cannot have come from this machine's own UI. */
function checkOrigin(req) {
	const peer = req.socket?.remoteAddress;
	if (typeof peer === "string" && peer !== "" && !LOOPBACK.has(peer)) return "only local requests are allowed";
	const origin = req.headers?.origin;
	const host = req.headers?.host;
	if (typeof origin === "string" && origin !== "" && (typeof host !== "string" || !origin.endsWith(`//${host}`))) {
		return "cross-origin request rejected";
	}
	return void 0;
}

export function apply(ctx) {
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "prefix",
				path: ROUTE,
				handler: async (req, res) => {
					const action = new URL(req.url ?? "/", "http://localhost").pathname
						.slice(ROUTE.length)
						.replace(/^\/+/, "")
						.replace(/\/+$/, "");
					const denied = checkOrigin(req);
					if (denied !== void 0) return sendJson(res, 403, { ok: false, error: denied });
					try {
						if (req.method === "GET" && action === "") {
							return sendJson(res, 200, { ok: true, service: name, revision: REVISION });
						}
						if (req.method === "GET" && action === "list") {
							return sendJson(res, 200, { ok: true, sessions: await listSessions(ctx) });
						}
						if (req.method === "GET" && action === "trash") {
							return sendJson(res, 200, await listTrash(ctx));
						}
						if (req.method === "GET" && action === "diag") {
							const clientModules = ctx.get?.("clientModules");
							const graph = clientModules?.graph?.();
							const sessions = ctx.get?.("sessions");
							const agents = ctx.get?.("agents");
							return sendJson(res, 200, {
								ok: true,
								revision: REVISION,
								registered: clientModules !== undefined,
								table: clientModules?.table === undefined ? null : [...clientModules.table.keys()],
								entries: graph?.entries?.map((entry) => ({
									id: entry.id,
									rev: entry.rev,
									url: entry.url,
									inject: entry.inject ?? null
								})) ?? null,
								batches: graph?.batches?.map((batch) => ({ phase: batch.phase, url: batch.url })) ?? null,
								live: {
									sessions: [...(storeOf(sessions)?.keys() ?? [])],
									agents: [...(storeOf(agents)?.keys() ?? [])]
								},
								supports: {
									sessionsDetachEntered: typeof sessions?.detachEntered === "function",
									agentsDetachEntered: typeof agents?.detachEntered === "function"
								}
							});
						}
						if (req.method !== "POST") {
							return sendJson(res, 405, { ok: false, error: `unsupported method ${req.method}` });
						}
						const body = await readJson(req);
						if (action === "delete") {
							return sendJson(res, 200, await deleteSession(ctx, body.sessionId));
						}
						if (action === "restore") {
							return sendJson(res, 200, await restoreTrash(ctx, body.name));
						}
						if (action === "purge") {
							return sendJson(res, 200, await purgeTrash(ctx, body.name));
						}
						if (action === "empty-trash") {
							return sendJson(res, 200, await emptyTrash(ctx));
						}
						return sendJson(res, 404, { ok: false, error: `unknown action ${action}` });
					} catch (error) {
						ctx.logger?.warn?.(`${name}: ${action || "(root)"} failed: ${message(error)}`);
						return sendJson(res, 200, { ok: false, error: message(error) });
					}
				}
			}),
		`${name}: routes`
	);
}
