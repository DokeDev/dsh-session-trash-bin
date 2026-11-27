/**
 * dsh-session-trash-bin — Client half.
 *
 * Based on TuWeiZhi/dsh-session-delete (MIT).
 *
 * Adds two items to the session context menu:
 *   - "Delete session": moves the session into the plugin's trash bin;
 *   - "Session trash…": lists trashed sessions with Restore and Delete permanently.
 *
 * Plain DOM only: no React internals, no app CSS classes, no extra dependencies.
 * The overlay is appended to `document.body`, so it stays above the sidebar
 * drawer and every app panel.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-trash-bin",
	factory: function factory() {
		"use strict";

		const ROUTE = "/dsh-session-trash-bin";
		const MENU_ID = "session.trash-bin";
		const STYLE_ID = "dsh-session-trash-bin-style";
		const OVERLAY_ID = "dsh-session-trash-bin-overlay";

		const MESSAGES = {
			zh: {
				deleteMenu: "删除会话",
				trashMenu: "会话垃圾箱…",
				deleteTitle: "删除会话",
				deleteDesc: (title) =>
					typeof title === "string" && title.trim() !== ""
						? "将把会话「" + title + "」移入会话垃圾箱。"
						: "将把该会话移入会话垃圾箱。",
				deleteHint: "侧栏里的这一行会立即消失，但会话仍可在「会话垃圾箱」中恢复；不会立即永久删除。",
				deleteConfirm: "移入垃圾箱",
				deleteBusy: "正在移入…",
				cancel: "取消",
				deleteDone: "会话已移入垃圾箱",
				deleteWarn: "会话已移入垃圾箱，但有部分数据未能清理，请查看插件日志。",
				restoreAction: "恢复",
				restoreFailed: "恢复失败",
				restored: "会话已恢复",
				restoredWithWarnings: "会话已恢复，但部分工作区状态没有恢复。",
				trashTitle: "会话垃圾箱",
				trashHint: "这里保存已删除的会话。恢复会把会话放回原来的工作区；彻底删除后无法恢复。子代理会话和附件不在此列。",
				trashLoading: "正在读取垃圾箱…",
				trashEmpty: "垃圾箱是空的。",
				trashCount: (count) => "共 " + count + " 项",
				trashClose: "关闭",
				trashRefresh: "刷新",
				restore: "恢复",
				restoreBusy: "恢复中…",
				purge: "彻底删除",
				purgeConfirm: "确认彻底删除？",
				purgeBusy: "删除中…",
				purgeDone: "已彻底删除",
				emptyTrash: "清空垃圾箱",
				emptyConfirm: "确认清空全部？",
				emptyBusy: "清空中…",
				emptyDone: (count) => "已清空 " + count + " 项",
				legacy: "旧条目：缺少恢复信息，只能彻底删除。",
				sessionLine: (id) => "ID：" + id,
				failed: "操作失败",
				loadFailed: "读取垃圾箱失败",
				noSession: "（无标题会话）"
			},
			en: {
				deleteMenu: "Delete session",
				trashMenu: "Session trash…",
				deleteTitle: "Delete session",
				deleteDesc: (title) =>
					typeof title === "string" && title.trim() !== ""
						? "Move “" + title + "” to the session trash."
						: "Move this session to the session trash.",
				deleteHint: "The sidebar row disappears immediately, but the session can be restored from Session trash. It is not permanently deleted yet.",
				deleteConfirm: "Move to trash",
				deleteBusy: "Moving…",
				cancel: "Cancel",
				deleteDone: "Session moved to the trash",
				deleteWarn: "The session moved to the trash, but some data could not be cleaned up. Check the plugin log.",
				restoreAction: "Restore",
				restoreFailed: "Restore failed",
				restored: "Session restored",
				restoredWithWarnings: "The session was restored, but some workspace state could not be restored.",
				trashTitle: "Session trash",
				trashHint: "Deleted sessions are kept here. Restore puts a session back into its workspace; permanent deletion cannot be undone. Subagent sessions and attachments are not included.",
				trashLoading: "Reading the session trash…",
				trashEmpty: "The session trash is empty.",
				trashCount: (count) => count + (count === 1 ? " item" : " items"),
				trashClose: "Close",
				trashRefresh: "Refresh",
				restore: "Restore",
				restoreBusy: "Restoring…",
				purge: "Delete permanently",
				purgeConfirm: "Confirm permanent delete?",
				purgeBusy: "Deleting…",
				purgeDone: "Permanently deleted",
				emptyTrash: "Empty trash",
				emptyConfirm: "Confirm empty all?",
				emptyBusy: "Emptying…",
				emptyDone: (count) => "Emptied " + count + (count === 1 ? " item" : " items"),
				legacy: "Legacy entry: no restore metadata, so it can only be permanently deleted.",
				sessionLine: (id) => "ID: " + id,
				failed: "Operation failed",
				loadFailed: "Could not read the session trash",
				noSession: "(Untitled session)"
			}
		};

		/** Follow the page language, not the plugin's own. */
		function strings() {
			const tag = (document.documentElement.getAttribute("lang") || navigator.language || "en").toLowerCase();
			return tag.startsWith("zh") ? MESSAGES.zh : MESSAGES.en;
		}

		/**
		 * Decide which palette the dialog should use. `:root { color-scheme }` is
		 * authoritative in DSH; a transparent body background must never recurse
		 * into `documentElement` (both can be transparent, which used to blow the
		 * stack before any request was made).
		 */
		function isDarkBackground(color) {
			let fallback = true;
			try {
				const scheme = window.getComputedStyle(document.documentElement).colorScheme;
				if (scheme === "dark") fallback = true;
				else if (scheme === "light") fallback = false;
				else if (typeof window.matchMedia === "function") {
					fallback = window.matchMedia("(prefers-color-scheme: dark)").matches;
				}
			} catch {
				/* keep the dark fallback */
			}
			const match = /rgba?\(([^)]+)\)/.exec(color || "");
			if (match === null) return fallback;
			const [r, g, b, a] = match[1].split(",").map((part) => Number.parseFloat(part));
			if (Number.isFinite(a) && a === 0) return fallback;
			if (![r, g, b].every((channel) => Number.isFinite(channel))) return fallback;
			return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
		}

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				"#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font:13px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;}",
				"#" + OVERLAY_ID + " .dsd-panel{display:flex;flex-direction:column;min-width:320px;max-width:min(440px,92vw);max-height:86vh;padding:18px 18px 14px;border-radius:10px;border:1px solid var(--dsd-border);background:var(--dsd-bg);color:var(--dsd-fg);box-shadow:0 18px 48px rgba(0,0,0,.35);}",
				"#" + OVERLAY_ID + " .dsd-panel.dsd-wide{max-width:min(600px,94vw);width:600px;}",
				"#" + OVERLAY_ID + " .dsd-title{font-size:14px;font-weight:600;margin:0 0 8px;}",
				"#" + OVERLAY_ID + " .dsd-desc{margin:0 0 6px;opacity:.82;white-space:pre-wrap;word-break:break-word;}",
				"#" + OVERLAY_ID + " .dsd-hint{margin:0;font-size:12px;opacity:.6;}",
				"#" + OVERLAY_ID + " .dsd-error{margin:10px 0 0;color:#e5534b;font-size:12px;}",
				"#" + OVERLAY_ID + " .dsd-list{display:flex;flex-direction:column;gap:8px;margin:12px 0 0;overflow:auto;min-height:60px;flex:1 1 auto;}",
				"#" + OVERLAY_ID + " .dsd-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dsd-border);border-radius:8px;}",
				"#" + OVERLAY_ID + " .dsd-info{min-width:0;flex:1;}",
				"#" + OVERLAY_ID + " .dsd-row-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
				"#" + OVERLAY_ID + " .dsd-row-meta{margin-top:3px;font-size:11.5px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
				"#" + OVERLAY_ID + " .dsd-row-note{margin-top:3px;font-size:11.5px;color:#d08a2e;}",
				"#" + OVERLAY_ID + " .dsd-actions{display:flex;gap:6px;flex:none;}",
				"#" + OVERLAY_ID + " .dsd-empty{padding:26px 8px;text-align:center;opacity:.6;font-size:12.5px;}",
				"#" + OVERLAY_ID + " .dsd-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap;}",
				"#" + OVERLAY_ID + " .dsd-footer .dsd-spacer{flex:1;}",
				"#" + OVERLAY_ID + " button{font:inherit;padding:5px 14px;border-radius:6px;cursor:pointer;border:1px solid var(--dsd-border);background:transparent;color:inherit;}",
				"#" + OVERLAY_ID + " button.dsd-sm{font-size:12px;padding:4px 10px;}",
				"#" + OVERLAY_ID + " button[data-role=confirm]{border-color:transparent;background:#d0393b;color:#fff;}",
				"#" + OVERLAY_ID + " button[data-role=danger]{border-color:rgba(208,57,59,.5);color:#e5534b;}",
				"#" + OVERLAY_ID + " button[data-role=danger][data-armed]{border-color:transparent;background:#d0393b;color:#fff;}",
				"#" + OVERLAY_ID + " button:disabled{opacity:.55;cursor:default;}"
			].join("");
			document.head.appendChild(style);
		}

		/** Element that had focus before the current dialog opened. */
		let returnFocus = null;

		function closeDialog() {
			const overlay = document.getElementById(OVERLAY_ID);
			if (overlay !== null) overlay.remove();
			const target = returnFocus;
			returnFocus = null;
			if (target !== null && typeof target?.focus === "function") target.focus();
		}

		/** Keep Tab inside the dialog while it is open. */
		function trapFocus(overlay) {
			overlay.addEventListener("keydown", (event) => {
				if (event.key !== "Tab") return;
				const nodes = [...overlay.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")];
				if (nodes.length === 0) {
					event.preventDefault();
					return;
				}
				const first = nodes[0];
				const last = nodes[nodes.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			});
		}

		function makeOverlay() {
			ensureStyle();
			const dark = isDarkBackground(window.getComputedStyle(document.body).backgroundColor);
			const overlay = document.createElement("div");
			overlay.id = OVERLAY_ID;
			overlay.style.setProperty("--dsd-bg", dark ? "#26272b" : "#ffffff");
			overlay.style.setProperty("--dsd-fg", dark ? "#e8e8ea" : "#1f2023");
			overlay.style.setProperty("--dsd-border", dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.14)");
			const panel = document.createElement("div");
			panel.className = "dsd-panel";
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-modal", "true");
			overlay.append(panel);
			return { overlay, panel };
		}

		function errorNode() {
			const error = document.createElement("div");
			error.className = "dsd-error";
			error.hidden = true;
			return error;
		}

		function showError(error, reason, fallback) {
			error.hidden = false;
			error.textContent = reason instanceof Error && reason.message !== "" ? reason.message : fallback;
		}

		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes <= 0) return "";
			const units = ["B", "KB", "MB", "GB"];
			let value = bytes;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return value.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
		}

		function formatDate(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			const date = new Date(iso);
			return Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
		}

		async function requestJson(suffix, body) {
			const response = await fetch(ROUTE + suffix, body === void 0
				? { method: "GET" }
				: {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body)
				});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error(typeof payload?.error === "string" ? payload.error : strings().failed);
			}
			return payload;
		}

		const requestDelete = (sessionId) => requestJson("/delete", { sessionId });
		const requestTrash = () => requestJson("/trash");
		const requestRestore = (name) => requestJson("/restore", { name });
		const requestPurge = (name) => requestJson("/purge", { name });
		const requestEmptyTrash = () => requestJson("/empty-trash", {});

		function refreshSessions(ctx) {
			try {
				void ctx.get?.("sessions")?.refresh?.();
			} catch {
				/* the removal/addition event may already update the list */
			}
		}

		function notify(ctx, text, success, action) {
			try {
				ctx.contextMenus?.notify?.(text, success, action);
			} catch {
				/* feedback is optional */
			}
		}

		/** When the deleted session is the one on screen, return the main view to its empty state. */
		function leaveDeletedSession(ctx, sessionId) {
			try {
				const uiWorkspace = ctx.get?.("uiWorkspace");
				if (uiWorkspace === void 0) return;
				if (uiWorkspace.mainReference?.sessionId !== sessionId) return;
				uiWorkspace.clearMain?.();
			} catch (error) {
				console.warn("dsh-session-trash-bin: could not leave the deleted session", error);
			}
		}

		function arm(button, label, confirmLabel, busyLabel, action) {
			let timer = 0;
			const reset = () => {
				button.textContent = label;
				delete button.dataset.armed;
				window.clearTimeout(timer);
			};
			button.addEventListener("click", (event) => {
				event.stopPropagation();
				if (button.disabled) return;
				if (button.dataset.armed !== "1") {
					button.dataset.armed = "1";
					button.textContent = confirmLabel;
					timer = window.setTimeout(reset, 4000);
					return;
				}
				window.clearTimeout(timer);
				button.disabled = true;
				button.textContent = busyLabel;
				void Promise.resolve(action()).then(reset, reset);
			});
		}

		/** Delete dialog: move to trash, with a Restore action on the success toast. */
		function openDeleteDialog(ctx, sessionId, displayTitle) {
			const trigger = document.activeElement;
			closeDialog();
			returnFocus = trigger;
			const text = strings();
			const { overlay, panel } = makeOverlay();
			panel.setAttribute("aria-label", text.deleteTitle);

			const title = document.createElement("div");
			title.className = "dsd-title";
			title.textContent = text.deleteTitle;

			const description = document.createElement("p");
			description.className = "dsd-desc";
			description.textContent = text.deleteDesc(displayTitle);

			const hint = document.createElement("p");
			hint.className = "dsd-hint";
			hint.textContent = text.deleteHint;

			const error = errorNode();
			const footer = document.createElement("div");
			footer.className = "dsd-footer";

			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.textContent = text.cancel;
			cancel.addEventListener("click", (event) => {
				event.stopPropagation();
				closeDialog();
			});

			const confirm = document.createElement("button");
			confirm.type = "button";
			confirm.dataset.role = "confirm";
			confirm.textContent = text.deleteConfirm;
			confirm.addEventListener("click", (event) => {
				event.stopPropagation();
				if (confirm.disabled) return;
				cancel.disabled = true;
				confirm.disabled = true;
				confirm.textContent = text.deleteBusy;
				requestDelete(sessionId).then(
					(payload) => {
						closeDialog();
						leaveDeletedSession(ctx, sessionId);
						refreshSessions(ctx);
						const warnings = Array.isArray(payload.warnings) ? payload.warnings.length : 0;
						if (typeof payload.trashName !== "string" || payload.trashName === "") {
							notify(ctx, warnings > 0 ? text.deleteWarn : text.deleteDone, warnings === 0);
							return;
						}
						notify(ctx, warnings > 0 ? text.deleteWarn : text.deleteDone, warnings === 0, {
							label: text.restoreAction,
							run: async () => {
								const restored = await requestRestore(payload.trashName);
								refreshSessions(ctx);
								const restoredWarnings = Array.isArray(restored.warnings) ? restored.warnings.length : 0;
								notify(ctx, restoredWarnings > 0 ? text.restoredWithWarnings : text.restored, restoredWarnings === 0);
							},
							failureLabel: text.restoreFailed
						});
					},
					(reason) => {
						showError(error, reason, text.failed);
						cancel.disabled = false;
						confirm.disabled = false;
						confirm.textContent = text.deleteConfirm;
					}
				);
			});

			overlay.addEventListener("click", (event) => {
				event.stopPropagation();
				if (event.target === overlay) closeDialog();
			});
			panel.addEventListener("click", (event) => event.stopPropagation());
			overlay.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					closeDialog();
				}
			});
			trapFocus(overlay);

			footer.append(cancel, confirm);
			panel.append(title, description, hint, error, footer);
			document.body.append(overlay);
			window.setTimeout(() => cancel.focus(), 0);
		}

		/** Recycle-bin dialog: list, restore, permanently delete, empty. */
		function openTrashDialog(ctx) {
			const trigger = document.activeElement;
			closeDialog();
			returnFocus = trigger;
			const text = strings();
			const { overlay, panel } = makeOverlay();
			panel.classList.add("dsd-wide");
			panel.setAttribute("aria-label", text.trashTitle);

			const title = document.createElement("div");
			title.className = "dsd-title";
			title.textContent = text.trashTitle;

			const hint = document.createElement("p");
			hint.className = "dsd-hint";
			hint.textContent = text.trashHint;

			const error = errorNode();
			const list = document.createElement("div");
			list.className = "dsd-list";
			const footer = document.createElement("div");
			footer.className = "dsd-footer";

			let entries = [];
			let busy = false;
			let errorText = null;
			let disposed = false;

			const setBusy = (next) => {
				busy = next;
				render();
			};

			const render = () => {
				if (disposed) return;
				empty.disabled = busy || entries.length === 0;
				refresh.disabled = busy;
				error.hidden = errorText === null;
				if (errorText !== null) error.textContent = errorText;
				list.replaceChildren();
				if (busy && entries.length === 0) {
					const loading = document.createElement("div");
					loading.className = "dsd-empty";
					loading.textContent = text.trashLoading;
					list.append(loading);
					return;
				}
				if (entries.length === 0) {
					const emptyState = document.createElement("div");
					emptyState.className = "dsd-empty";
					emptyState.textContent = text.trashEmpty;
					list.append(emptyState);
				}
				for (const entry of entries) {
					const row = document.createElement("div");
					row.className = "dsd-row";
					const info = document.createElement("div");
					info.className = "dsd-info";
					const rowTitle = document.createElement("div");
					rowTitle.className = "dsd-row-title";
					rowTitle.textContent = typeof entry.title === "string" && entry.title.trim() !== ""
						? entry.title
						: text.noSession;
					rowTitle.title = rowTitle.textContent;
					const meta = document.createElement("div");
					meta.className = "dsd-row-meta";
					const parts = [];
					if (entry.deletedAt !== null && entry.deletedAt !== void 0) parts.push(formatDate(entry.deletedAt));
					if (Number.isFinite(entry.sizeBytes)) parts.push(formatBytes(entry.sizeBytes));
					parts.push(text.sessionLine(entry.sessionId));
					meta.textContent = parts.filter(Boolean).join(" · ");
					meta.title = meta.textContent;
					info.append(rowTitle, meta);
					if (entry.legacy === true) {
						const note = document.createElement("div");
						note.className = "dsd-row-note";
						note.textContent = text.legacy;
						info.append(note);
					}
					const actions = document.createElement("div");
					actions.className = "dsd-actions";

					const restore = document.createElement("button");
					restore.type = "button";
					restore.className = "dsd-sm";
					restore.textContent = text.restore;
					restore.disabled = busy || entry.legacy === true;
					restore.addEventListener("click", (event) => {
						event.stopPropagation();
						if (restore.disabled) return;
						errorText = null;
						setBusy(true);
						requestRestore(entry.name).then(
							(payload) => {
								entries = entries.filter((candidate) => candidate.name !== entry.name);
								busy = false;
								refreshSessions(ctx);
								const warnings = Array.isArray(payload.warnings) ? payload.warnings.length : 0;
								notify(ctx, warnings > 0 ? text.restoredWithWarnings : text.restored, warnings === 0);
								render();
							},
							(reason) => {
								busy = false;
								errorText = reason instanceof Error && reason.message !== "" ? reason.message : text.failed;
								render();
							}
						);
					});

					const purge = document.createElement("button");
					purge.type = "button";
					purge.className = "dsd-sm";
					purge.dataset.role = "danger";
					purge.textContent = text.purge;
					purge.disabled = busy;
					arm(purge, text.purge, text.purgeConfirm, text.purgeBusy, async () => {
						errorText = null;
						setBusy(true);
						try {
							await requestPurge(entry.name);
							entries = entries.filter((candidate) => candidate.name !== entry.name);
							notify(ctx, text.purgeDone, true);
						} catch (reason) {
							errorText = reason instanceof Error && reason.message !== "" ? reason.message : text.failed;
						} finally {
							busy = false;
							render();
						}
					});
					actions.append(restore, purge);
					row.append(info, actions);
					list.append(row);
				}
			};

			const empty = document.createElement("button");
			empty.type = "button";
			empty.dataset.role = "danger";
			empty.textContent = text.emptyTrash;
			empty.disabled = true;
			arm(empty, text.emptyTrash, text.emptyConfirm, text.emptyBusy, async () => {
				errorText = null;
				setBusy(true);
				try {
					const payload = await requestEmptyTrash();
					const removed = Number.isFinite(payload.removed) ? payload.removed : 0;
					entries = [];
					notify(ctx, text.emptyDone(removed), true);
				} catch (reason) {
					errorText = reason instanceof Error && reason.message !== "" ? reason.message : text.failed;
				} finally {
					busy = false;
					render();
				}
			});

			const refresh = document.createElement("button");
			refresh.type = "button";
			refresh.textContent = text.trashRefresh;
			refresh.disabled = false;
			refresh.addEventListener("click", (event) => {
				event.stopPropagation();
				if (busy) return;
				void load();
			});

			const close = document.createElement("button");
			close.type = "button";
			close.textContent = text.trashClose;
			close.addEventListener("click", (event) => {
				event.stopPropagation();
				closeDialog();
			});

			const spacer = document.createElement("div");
			spacer.className = "dsd-spacer";
			footer.append(empty, spacer, refresh, close);

			const load = async () => {
				errorText = null;
				setBusy(true);
				try {
					const payload = await requestTrash();
					entries = Array.isArray(payload.entries) ? payload.entries : [];
				} catch (reason) {
					errorText = reason instanceof Error && reason.message !== "" ? reason.message : text.loadFailed;
				} finally {
					busy = false;
					render();
				}
			};

			overlay.addEventListener("click", (event) => {
				event.stopPropagation();
				if (event.target === overlay) closeDialog();
			});
			panel.addEventListener("click", (event) => event.stopPropagation());
			overlay.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					closeDialog();
				}
			});
			trapFocus(overlay);

			panel.append(title, hint, error, list, footer);
			document.body.append(overlay);
			window.setTimeout(() => close.focus(), 0);
			void load();
		}

		const name = "session-trash-bin";
		const inject = ["contextMenus"];

		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.contextMenus.register({
						id: MENU_ID,
						target: "session",
						order: 700,
						resolve: (target) => {
							const sessionId = target === null || typeof target !== "object" ? void 0 : target.sessionId;
							if (typeof sessionId !== "string" || sessionId === "") return [];
							const text = strings();
							return [
								{
									id: "delete",
									label: text.deleteMenu,
									separatorBefore: true,
									afterContent: true,
									danger: true,
									run: () => openDeleteDialog(ctx, sessionId, target.displayTitle)
								},
								{
									id: "trash",
									label: text.trashMenu,
									afterContent: true,
									run: () => openTrashDialog(ctx)
								}
							];
						}
					}),
				"dsh-session-trash-bin: session menu"
			);

			// A workspace row is still present when every conversation is gone, so
			// the trash bin stays reachable from its "..." menu too.
			ctx.effect(
				() =>
					ctx.contextMenus.register({
						id: MENU_ID + ".workspace",
						target: "workspace",
						order: 700,
						resolve: () => [
							{
								id: "trash",
								label: strings().trashMenu,
								afterContent: true,
								run: () => openTrashDialog(ctx)
							}
						]
					}),
				"dsh-session-trash-bin: workspace menu"
			);
		}

		return { apply, inject, name };
	}
});
