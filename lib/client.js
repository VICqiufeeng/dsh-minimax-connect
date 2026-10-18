/**
 * DSH Connect MiniMax — client half.
 *
 * A dedicated page in the Settings sidebar (the `settings.section` slot), same
 * shape as the WorkBuddy pool page. It renders from the host routes the server
 * half serves, so every number is fetched live rather than duplicated here.
 *
 * Three blocks: points + check-in + account, a configurable model list
 * (enable / image input / context window), and the save row.
 *
 * Built by hand, no bundler: this file is already inside the
 * `__ModuleLoader__.load` envelope.
 */
window.__ModuleLoader__.load({
	id: "dsh-minimax-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require("react");
		let jsx = require("react/jsx-runtime");

		const PROVIDER_NS = "llm-minimax";
		const STATUS = "/plugins/dsh-minimax-connect/status";
		const MODELS = "/plugins/dsh-minimax-connect/models";
		const SAVE = "/plugins/dsh-minimax-connect/__save";
		const CLAIM = "/plugins/dsh-minimax-connect/signin/claim";

		async function getJson(url, init) {
			const r = await fetch(url, {
				...init,
				headers: { accept: "application/json", "content-type": "application/json", ...(init?.headers ?? {}) },
			});
			const text = await r.text();
			try { return JSON.parse(text); } catch { return { error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
		}
		async function postJson(url, body) {
			return getJson(url, { method: "POST", body: JSON.stringify(body) });
		}

		const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—");
		const kfmt = (n) => (typeof n !== "number" ? "—" : n >= 1e6 ? n / 1e6 + "M" : n / 1000 + "K");

		const CSS = `
[data-dsh-mm]{display:flex;flex-direction:column;gap:12px}
[data-dsh-mm] .mm-row{display:flex;gap:12px;flex-wrap:wrap}
[data-dsh-mm] .mm-card{flex:1 1 200px;border:1px solid var(--dsh-border,#33353c);border-radius:10px;padding:14px}
[data-dsh-mm] .mm-big{font-size:28px;font-weight:600;line-height:1.2}
[data-dsh-mm] .mm-muted{opacity:.65;font-size:12px}
[data-dsh-mm] .mm-hd{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
[data-dsh-mm] button{padding:7px 13px;border-radius:8px;border:1px solid transparent;background:var(--dsh-accent,#3b6ef6);
  color:#fff;cursor:pointer;font:inherit}
[data-dsh-mm] button:disabled{background:transparent;border-color:var(--dsh-border,#4a4d55);opacity:.6;cursor:default;color:inherit}
[data-dsh-mm] button.mm-ghost{background:transparent;border-color:var(--dsh-border,#4a4d55);color:inherit}
[data-dsh-mm] .mm-list{border:1px solid var(--dsh-border,#33353c);border-radius:10px;overflow:hidden}
[data-dsh-mm] .mm-item{padding:10px 12px;border-bottom:1px solid var(--dsh-border,#33353c)}
[data-dsh-mm] .mm-item:last-child{border-bottom:0}
[data-dsh-mm] .mm-top{display:flex;align-items:center;gap:10px}
[data-dsh-mm] .mm-name{font-weight:500}
[data-dsh-mm] .mm-spacer{flex:1}
[data-dsh-mm] label{display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap}
[data-dsh-mm] .mm-sub{margin-top:4px;font-size:12px;opacity:.65}
[data-dsh-mm] .mm-err{color:#ff8a80;font-size:12px;white-space:pre-wrap}
[data-dsh-mm] .mm-ok{color:#4ade80;font-size:12px}
[data-dsh-mm] table{border-collapse:collapse;font-size:12px;width:100%}
[data-dsh-mm] th,[data-dsh-mm] td{border-bottom:1px solid var(--dsh-border,#33353c);padding:5px 8px;text-align:left}
`;

		/**
		 * One line saying who keeps the credential alive.
		 *
		 * The card used to imply MiniMax Code had to be running for the provider
		 * to work. The host half renews the OAuth grant on its own now, so the
		 * line reports that instead — and calls out the one case that still needs
		 * the desktop app: a record with no refreshToken in it.
		 */
		function renewalLine(data) {
			const r = data.selfRenewal;
			if (!r) return null;
			if (!r.hasRefreshToken) return { cls: "mm-err", text: "凭据没有 refreshToken，需在 MiniMax Code 里重新登录一次" };
			if (r.blocked) return { cls: "mm-err", text: `自动续期暂停，${new Date(r.blockedUntil).toLocaleTimeString()} 后重试` };
			if (r.inFlight) return { cls: "mm-ok", text: "正在自动续期…" };
			return { cls: "mm-ok", text: `自动续期已启用（到期前 ${Math.round(r.marginMs / 60000)} 分钟），不用打开 MiniMax Code` };
		}

		/** Points, check-in and account in one row. */
		function Overview({ data, onClaim, busy, note }) {
			const p = data.points;
			const s = data.signin;
			const canClaim = Boolean(s && s.claimableToday && !s.claimedToday && !busy);
			const renewal = data.signedIn || data.selfRenewal ? renewalLine(data) : null;
			return jsx.jsxs("div", { className: "mm-row", children: [
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "积分余额" }),
					jsx.jsx("div", { className: "mm-big", children: p ? fmt(p.remaining) : "—" }),
					p ? jsx.jsx("div", { className: "mm-muted", children: `已用 ${fmt(p.consumed)} / 授予 ${fmt(p.granted)}` }) : null,
				]}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "每日签到" }),
					jsx.jsx("div", { className: "mm-big", children: s ? (s.claimedToday ? "已领" : "待领") : "—" }),
					s ? jsx.jsx("div", { className: "mm-muted", children: `今日 +${s.todayPoints ?? 0} 积分` }) : null,
					jsx.jsx("button", {
						disabled: !canClaim,
						onClick: onClaim,
						children: busy ? "签到中…" : (canClaim ? "立即签到" : (s && s.claimedToday ? "今日已签到" : "暂不可签")),
					}),
					note ? jsx.jsx("div", { className: note.indexOf("成功") >= 0 ? "mm-ok" : "mm-err", children: note }) : null,
				]}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsx("div", { className: "mm-muted", children: "账号" }),
					jsx.jsx("div", { children: data.signedIn ? "已登录 MiniMax Code" : "未登录" }),
					data.expiresAtMs ? jsx.jsx("div", { className: "mm-muted", children: `token 到期 ${new Date(data.expiresAtMs).toLocaleString()}` }) : null,
					renewal ? jsx.jsx("div", { className: renewal.cls, children: renewal.text }) : null,
					!data.signedIn && data.reason ? jsx.jsx("div", { className: "mm-err", children: data.reason }) : null,
				]}),
			] });
		}

		/** The configurable model list. */
		function ModelList({ rows, draft, setDraft, activeCount, totalCount, source, onRefresh, refreshing }) {
			const setEnabled = (id, on) => setDraft((d) => ({ ...d, enabled: { ...d.enabled, [id]: on } }));
			const setImage = (id, mode) => setDraft((d) => ({ ...d, image: { ...d.image, [id]: mode } }));
			return jsx.jsxs("div", { className: "mm-card", children: [
				jsx.jsxs("div", { className: "mm-hd", children: [
					jsx.jsxs("div", { children: [
						jsx.jsx("div", { className: "mm-name", children: "模型" }),
						jsx.jsxs("div", { className: "mm-muted", children: [`已启用 ${activeCount} / ${totalCount}`, source ? `　来源：${source}` : ""] }),
					] }),
					jsx.jsxs("div", { style: { display: "flex", gap: "8px" }, children: [
						jsx.jsx("button", { className: "mm-ghost", disabled: refreshing, onClick: onRefresh, children: refreshing ? "读取中…" : "重新获取模型" }),
					] }),
				] }),
				jsx.jsx("div", { className: "mm-list", style: { marginTop: "10px" }, children: rows.map((m) => jsx.jsxs("div", { className: "mm-item", children: [
					jsx.jsxs("div", { className: "mm-top", children: [
						jsx.jsx("label", { children: [
							jsx.jsx("input", { type: "checkbox", checked: draft.enabled[m.id] !== false, onChange: (e) => setEnabled(m.id, e.target.checked) }),
							jsx.jsx("span", { className: "mm-name", children: m.name }),
						] }),
						jsx.jsx("span", { className: "mm-spacer" }),
						jsx.jsx("label", { children: [
							"图像输入",
							jsx.jsx("select", {
								value: draft.image[m.id] ?? "auto",
								onChange: (e) => setImage(m.id, e.target.value),
								children: ["auto", "on", "off"].map((v) => jsx.jsx("option", { value: v, children: v === "auto" ? "自动" : v === "on" ? "开" : "关" }, v)),
							}),
						] }),
					] }),
					jsx.jsxs("div", { className: "mm-sub", children: [
						`上下文 ${kfmt(draft.maxCtx ? m.contextMax : m.context)}`,
						m.contextMax > m.context ? `（可选 ${kfmt(m.contextMax)}）` : "",
						`　输出 ${kfmt(m.maxTokens)}`,
						m.vision ? "　模型支持图像" : "",
					] }),
				] }, m.id)) }),
			] });
		}

		function MiniMaxCard({ t }) {
			const [data, setData] = react.useState(null);
			const [modelData, setModelData] = react.useState(null);
			const [draft, setDraft] = react.useState({ enabled: {}, image: {}, maxCtx: false });
			const [busy, setBusy] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [saveNote, setSaveNote] = react.useState("");
			const [refreshing, setRefreshing] = react.useState(false);
			const [dirty, setDirty] = react.useState(false);

			/**
			 * Read the status + model rows.
			 *
			 * `adopt` decides whether the fetched values replace the draft. It is
			 * passed explicitly rather than inferred, because the save path must
			 * adopt (the document is now the truth) while a background interval
			 * must not (it would silently discard staged edits).
			 */
			const loadAll = react.useCallback(async (refresh, adopt) => {
				try { setData(await getJson(STATUS)); } catch (e) { setData({ __failed: String(e.message ?? e) }); }
				try {
					const m = await getJson(MODELS + (refresh ? "?refresh=1" : ""));
					setModelData(m);
					if (adopt) {
						const enabled = {};
						const image = {};
						for (const row of m.models ?? []) {
							enabled[row.id] = row.enabled !== false;
							image[row.id] = row.imageMode ?? "auto";
						}
						setDraft({ enabled, image, maxCtx: m.preferMaximumContext === true });
					}
				} catch (e) { setModelData({ __failed: String(e.message ?? e) }); }
			}, []);

			react.useEffect(() => { loadAll(false, true); }, [loadAll]);
			react.useEffect(() => {
				const id = window.setInterval(() => {
					getJson(STATUS).then(setData).catch(() => {});
				}, 30000);
				return () => window.clearInterval(id);
			}, []);

			const claim = react.useCallback(async () => {
				setBusy(true); setNote("");
				try {
					const r = await postJson(CLAIM, {});
					setNote(r.ok ? "签到成功" : `签到失败：${r.error ?? "未知原因"}`);
					const s = await getJson(STATUS);
					setData(s);
				} catch (e) { setNote(`签到失败：${String(e.message ?? e)}`); }
				finally { setBusy(false); }
			}, []);

			const markDirty = (fn) => { setDirty(true); setSaveNote(""); setDraft(fn); };

			const save = react.useCallback(async () => {
				setSaving(true); setSaveNote("");
				try {
					for (const [field, value] of [
						["enabledModelIds", draft.enabled],
						["imageOverrides", draft.image],
						["useMaximumContextWindow", draft.maxCtx],
					]) {
						const r = await postJson(SAVE, { field, value });
						if (r.ok !== true) { setSaveNote(`保存失败（${field}）：${r.error ?? r.errorName ?? "未知"}`); return; }
					}
					setSaveNote("已保存");
					setDirty(false);
					await loadAll(false, true);
				} catch (e) { setSaveNote(`保存失败：${String(e.message ?? e)}`); }
				finally { setSaving(false); }
			}, [draft, loadAll]);

			if (data === null) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-muted", children: "读取中…" }) });
			if (data.__failed) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-err", children: `无法读取状态：${data.__failed}` }) });

			const rows = modelData?.models ?? [];
			const activeCount = rows.filter((m) => draft.enabled[m.id] !== false).length;

			return jsx.jsxs("div", { "data-dsh-mm": "", children: [
				jsx.jsx(Overview, { data, onClaim: claim, busy, note }),
				modelData?.__failed
					? jsx.jsx("div", { className: "mm-card mm-err", children: `无法读取模型：${modelData.__failed}` })
					: jsx.jsx(ModelList, {
						rows,
						draft,
						setDraft: markDirty,
						activeCount,
						totalCount: rows.length,
						source: modelData?.source,
						refreshing,
						onRefresh: async () => { setRefreshing(true); await loadAll(true, !dirty); setRefreshing(false); },
					}),
				jsx.jsxs("div", { className: "mm-card", children: [
					jsx.jsxs("div", { className: "mm-hd", children: [
						jsx.jsxs("label", { children: [
							jsx.jsx("input", {
								type: "checkbox",
								checked: draft.maxCtx,
								onChange: (e) => markDirty((d) => ({ ...d, maxCtx: e.target.checked })),
							}),
							"使用最大上下文窗口（消耗更多积分）",
						] }),
						jsx.jsxs("div", { style: { display: "flex", gap: "8px", alignItems: "center" }, children: [
							saveNote ? jsx.jsx("span", { className: saveNote === "已保存" ? "mm-ok" : "mm-err", children: saveNote }) : null,
							jsx.jsx("button", {
								className: "mm-ghost",
								disabled: !dirty || saving,
								onClick: () => { setDirty(false); setSaveNote(""); loadAll(false, true); },
								children: "放弃修改",
							}),
							jsx.jsx("button", { disabled: !dirty || saving, onClick: save, children: saving ? "保存中…" : "保存" }),
						] }),
					] }),
					dirty ? jsx.jsx("div", { className: "mm-muted", style: { marginTop: "6px" }, children: "有未保存的修改" }) : null,
				] }),
				(data.errors ?? []).length > 0 ? jsx.jsx("div", { className: "mm-card mm-err", children: data.errors.join("\n") }) : null,
			] });
		}

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-dsh-mm-css]")) return;
			const tag = document.createElement("style");
			tag.dataset.dshMmCss = "1";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const zh = { "row.navLabel": "MiniMax", "row.title": "MiniMax Code（积分）" };
		const en = { "row.navLabel": "MiniMax", "row.title": "MiniMax Code (points)" };

		function apply(ctx) {
			try {
				installStyles();
				const namespace = "settings.minimax-connect";
				ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-minimax-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				const forms = ctx.get("configForms");
				let settingsScope;
				if (forms !== undefined && typeof forms.get === "function") {
					try { settingsScope = forms.get(namespace); } catch { settingsScope = undefined; }
				}

				const register = (slotName, id, order, label) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName, id, order,
							...(slotName.startsWith("plugins.") ? { key: id } : {}),
							label: () => label,
							inject: () => (settingsScope === undefined ? { t } : { t, settingsScope }),
						}, MiniMaxCard));
					} catch (error) {
						console.error(`[dsh-minimax-connect] slot "${slotName}" failed to register:`, error);
					}
				};

				register("settings.section", "minimax-connect", 460, t("row.navLabel"));
				for (const bundle of ["dsh-minimax-connect"]) {
					register("plugins.bundle.config", bundle, 30, t("row.title"));
					register("plugins.row.config", `${bundle}#${PROVIDER_NS}`, 30, t("row.title"));
				}
				register("settings.plugin.item", "minimax", 30, t("row.title"));
			} catch (error) {
				console.error("[dsh-minimax-connect] client page failed to load (host provider unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		exports.name = "dsh-minimax-connect-client";
		return module.exports;
	},
});
