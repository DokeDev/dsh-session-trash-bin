/**
 * Browser-half smoke test: load the Module Loader factory, apply it against a
 * fake Cordis context, and inspect the two menu contributions. No DOM is
 * rendered; the actions only run when a user clicks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

let loaded;
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			loaded = spec;
		}
	}
};
globalThis.document = { documentElement: { getAttribute: () => "en" } };
await import("../lib/client.js");

test("client registers Delete session and Session trash menu actions", () => {
	assert.equal(loaded.id, "dsh-session-trash-bin");
	const contributions = [];
	const ctx = {
		effect(fn) {
			fn();
		},
		contextMenus: {
			register(contribution) {
				contributions.push(contribution);
				return () => void 0;
			}
		}
	};
	const exports = loaded.factory(() => {
		throw new Error("client must not require any module");
	});
	assert.equal(exports.name, "session-trash-bin");
	assert.deepEqual(exports.inject, ["contextMenus"]);
	exports.apply(ctx);

	assert.equal(contributions.length, 2);
	const menu = contributions.find((contribution) => contribution.target === "session");
	const workspaceMenu = contributions.find((contribution) => contribution.target === "workspace");
	assert.ok(menu);
	assert.ok(workspaceMenu);
	const workspaceActions = workspaceMenu.resolve({ workspaceId: "workspace-1" });
	assert.deepEqual(workspaceActions.map((action) => action.id), ["trash"]);
	assert.equal(menu.id, "session.trash-bin");
	assert.equal(menu.target, "session");
	const actions = menu.resolve({ sessionId: "session-1", displayTitle: "Demo" });
	assert.deepEqual(actions.map((action) => action.id), ["delete", "trash"]);
	assert.equal(actions[0].danger, true);
	assert.equal(actions[0].label, "Delete session");
	assert.equal(actions[1].label, "Session trash…");
	assert.deepEqual(menu.resolve({ sessionId: "" }), []);
});
