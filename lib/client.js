/**
 * DSH Connect MiniMax — client half.
 *
 * A dedicated page in the Settings sidebar (the `settings.section` slot), plus
 * the same card seated on the plugin manager's bundle/row pages.
 *
 * Three blocks: points + check-in + account, a configurable model list
 * (enable / image input / context window), and the save row.
 *
 * Two different namespaces live in this file and they are not interchangeable:
 *
 *   SETTINGS_NS  `llm-minimax` — the Loader row id from `cordis.patch.yml`.
 *                This is what the settings service addresses, so it is the
 *                namespace every read and write must use.
 *   COPY_NS      `settings.minimax-connect` — this card's own dictionary id.
 *                Nothing but `ctx.locale` ever sees it.
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

		/** Loader row id — the settings namespace, and the provider route key. */
		const SETTINGS_NS = "llm-minimax";
		/** Locale dictionary id for this card's copy. */
		const COPY_NS = "settings.minimax-connect";
		/** Package name, as `package.json` declares it. */
		const BUNDLE = "dsh-minimax-connect";

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

		/**
		 * Compact a token count.
		 *
		 * Rounded to at most one decimal and with the trailing `.0` dropped, so
		 * the catalogue's 512000 / 1000000 / 128000 read as 512K / 1M / 128K
		 * rather than 512K / 1M / 128.00000000000001K.
		 */
		function kfmt(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "—";
			const scale = n >= 1e6 ? [1e6, "M"] : [1e3, "K"];
			const value = Math.round((n / scale[0]) * 10) / 10;
			return `${value}${scale[1]}`;
		}

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
			const done = typeof r.generation === "number" && r.generation > 0 ? `，已自动续期 ${r.generation} 次` : "";
			return { cls: "mm-ok", text: `自动续期已启用（到期前 ${Math.round(r.marginMs / 60000)} 分钟${done}），不用打开 MiniMax Code` };
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

		/**
		 * The account's plan, quota, and what it buys.
		 *
		 * Every field here comes from the commerce routes the MiniMax Code
		 * desktop client itself calls (`/matrix/api/v1/...`), read by the host
		 * half. A field the service did not send reads "接口未返回" instead of
		 * a guess — the tier catalogue on the pricing page is marketing data
		 * that these APIs do not publish, so the card reports the account's own
		 * state and nothing more.
		 *
		 * The model roster shown at the bottom is the account's working
		 * catalogue (read from MiniMax Code's own provider config), which is
		 * the honest answer to "which models does my plan include" for the
		 * models this plugin can actually reach.
		 */
		function Membership({ membership, models }) {
			const m = membership;
			if (!m) return null;
			if (!m.ok) {
				return jsx.jsx("div", { className: "mm-card mm-err", children: `无法读取订阅信息：${m.reason ?? "未知原因"}` });
			}
			const amount = (v) => (v === null || v === undefined ? "接口未返回" : fmt(v));
			const plan = m.planName
				?? (m.hasTokenPlan ? "倍用量套餐" : (m.subscriptionType && m.subscriptionType !== "none" ? m.subscriptionType : "未订阅（仅免费额度）"));
			const rows = [
				["套餐", plan],
				["订阅类型", m.subscriptionType ?? "接口未返回"],
				["倍用量", m.multiplier === null || m.multiplier === undefined ? "接口未返回" : `${m.multiplier}x`],
				["额度余额", amount(m.remaining)],
				["　其中订阅额度", amount(m.purchasedRemaining)],
				["　其中免费额度", amount(m.freeRemaining)],
				["待入账", amount(m.pendingCredit)],
				["每日登录赠送", amount(m.dailyGiftRemaining)],
				["到期时间", m.expiresAtMs ? new Date(m.expiresAtMs).toLocaleString() : (m.hasTokenPlan ? "接口未返回" : "无固定到期时间")],
				["自动续费", m.willRenew ? "是" : "否"],
				["续费周期", m.upgradeAction ?? "接口未返回"],
				["可升级", m.canUpgrade ? "是" : "否"],
				["工作区", m.workspaceName ?? "接口未返回"],
			];
			const names = (models ?? []).map((x) => x.name ?? x.id);
			return jsx.jsxs("div", { className: "mm-card", children: [
				jsx.jsxs("div", { className: "mm-hd", children: [
					jsx.jsxs("div", { children: [
						jsx.jsx("div", { className: "mm-name", children: "订阅额度" }),
						jsx.jsx("div", { className: "mm-muted", children: m.hasTokenPlan ? "倍用量套餐已开通" : "未开通倍用量套餐，当前使用免费额度" }),
					] }),
				] }),
				jsx.jsx("div", { className: "mm-list", style: { marginTop: "10px" }, children: rows.map(([k, v]) => jsx.jsx("div", { className: "mm-item", children: jsx.jsxs("div", { className: "mm-top", children: [
					jsx.jsx("span", { className: "mm-name", children: k }),
					jsx.jsx("span", { className: "mm-spacer" }),
					jsx.jsx("span", { children: v }),
				] }) }, k)) }),
				names.length > 0 ? jsx.jsx("div", { className: "mm-sub", style: { marginTop: "8px" }, children: `当前账号可用模型：${names.join("、")}` }) : null,
			] });
		}

		/**
		 * What the catalogue says about one model, as one muted line.
		 *
		 * `video` is reported but not offered: the Anthropic Messages transport
		 * this provider speaks carries text and image parts only, so listing a
		 * video input as selectable would promise something the wire cannot send.
		 */
		function modelFacts(m, maxCtx) {
			const parts = [`上下文 ${kfmt(maxCtx ? m.contextMax : m.context)}`];
			if (m.contextMax > m.context) parts.push(`（可选 ${kfmt(m.contextMax)}）`);
			parts.push(`　输出 ${kfmt(m.maxTokens)}`);
			if (m.vision) parts.push("　模型支持图像");
			if (m.video) parts.push("　目录含视频输入（传输层只送图文）");
			if (m.thinking === "forced_on") parts.push("　思考模式强制开启");
			else if (m.thinking === "switchable") parts.push("　思考模式可切换");
			if (m.filesApi) parts.push("　支持文件上传");
			return parts.join("");
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
						m.vision ? jsx.jsx("label", { children: [
							"图像输入",
							jsx.jsx("select", {
								value: draft.image[m.id] ?? "auto",
								onChange: (e) => setImage(m.id, e.target.value),
								children: ["auto", "on", "off"].map((v) => jsx.jsx("option", { value: v, children: v === "auto" ? "自动" : v === "on" ? "开" : "关" }, v)),
							}),
						] }) : jsx.jsx("span", { className: "mm-muted", children: "纯文本模型" }),
					] }),
					jsx.jsx("div", { className: "mm-sub", children: modelFacts(m, draft.maxCtx) }),
				] }, m.id)) }),
			] });
		}

		/**
		 * Write one field through the host's config form.
		 *
		 * `ConfigFormController.set` runs the edit through `remote.settings.mutate`
		 * with the revision the mirror currently holds, so a concurrent change
		 * elsewhere surfaces as a conflict the controller recovers from rather
		 * than as a silent overwrite. It resolves `false` when the write did not
		 * land.
		 */
		async function saveThroughForm(form, field, value) {
			try {
				const landed = await form.set(field, value);
				return landed === false
					? { ok: false, errorName: "conflict", error: "设置已在别处被修改，已重新读取，请再保存一次" }
					: { ok: true };
			} catch (error) {
				return { ok: false, errorName: error?.name ?? "unknown", error: String(error?.message ?? error) };
			}
		}

		/**
		 * Write one field through the plugin's own route.
		 *
		 * Kept as the fallback for hosts whose settings service does not publish
		 * this namespace (a row the Loader has not activated, or a build without
		 * `configForms`). The host half answers with the value it read back, so a
		 * write that did not land is reported instead of assumed.
		 */
		async function saveThroughRoute(field, value) {
			try {
				return await postJson(SAVE, { field, value });
			} catch (error) {
				return { ok: false, errorName: error?.name ?? "unknown", error: String(error?.message ?? error) };
			}
		}

		function MiniMaxCard({ t, form }) {
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
					const edits = [
						["enabledModelIds", draft.enabled],
						["imageOverrides", draft.image],
						["useMaximumContextWindow", draft.maxCtx],
					];
					for (const [field, value] of edits) {
						const r = form !== undefined
							? await saveThroughForm(form, field, value)
							: await saveThroughRoute(field, value);
						if (r.ok !== true) {
							setSaveNote(`保存失败（${field}）：${r.error ?? r.errorName ?? "未知"}`);
							return;
						}
					}
					setSaveNote("已保存");
					setDirty(false);
					await loadAll(false, true);
				} catch (e) { setSaveNote(`保存失败：${String(e?.message ?? e)}`); }
				finally { setSaving(false); }
			}, [draft, form, loadAll]);

			if (data === null) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-muted", children: "读取中…" }) });
			if (data.__failed) return jsx.jsx("div", { "data-dsh-mm": "", children: jsx.jsx("div", { className: "mm-err", children: `无法读取状态：${data.__failed}` }) });

			const rows = modelData?.models ?? [];
			const activeCount = rows.filter((m) => draft.enabled[m.id] !== false).length;

			return jsx.jsxs("div", { "data-dsh-mm": "", children: [
				jsx.jsx(Overview, { data, onClaim: claim, busy, note }),
				jsx.jsx(Membership, { membership: data.membership, models: rows }),
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
					form === undefined
						? jsx.jsx("div", { className: "mm-muted", style: { marginTop: "6px" }, children: `设置面板未就绪，保存将经由插件路由写入 ${SETTINGS_NS}` })
						: null,
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
				ctx.effect(() => ctx.locale.register(COPY_NS, { zh, en }), "dsh-minimax-connect: settings copy");
				const t = ctx.locale.bind(COPY_NS);

				/**
				 * The host's form for this plugin's own settings namespace.
				 *
				 * `configForms.get` keys on the Loader row id, so it must be
				 * `SETTINGS_NS` — asking for the locale id or the package name
				 * returns a controller bound to a namespace nothing serves, and
				 * every write through it would be rejected.
				 */
				let form;
				if (typeof ctx.configForms?.get === "function") {
					try { form = ctx.configForms.get(SETTINGS_NS); } catch { form = undefined; }
				}
				const face = () => (form === undefined ? { t } : { t, form });

				/** Seat the card in one slot; a slot the build does not declare is skipped. */
				const seat = (slot, options) => {
					try {
						ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({
							name: slot,
							locale: COPY_NS,
							inject: face,
							...options,
						}, MiniMaxCard)), `dsh-minimax-connect: ${slot}`);
					} catch (error) {
						console.error(`[dsh-minimax-connect] slot "${slot}" failed to register:`, error);
					}
				};

				// The Settings sidebar page. `settings.section` is a list slot, so
				// its cell key is `id` and the nav label is a thunk the shell
				// re-reads on every projection.
				seat("settings.section", {
					id: "minimax-connect",
					order: 460,
					label: () => t("row.navLabel"),
				});

				// The plugin manager's bundle page and this plugin's row page.
				// Both are keyed slots: `key`, never `id`, and the row key is
				// `<package name>#<row id>` exactly as the patch declares it.
				seat("plugins.bundle.config", { key: BUNDLE });
				seat("plugins.row.config", { key: `${BUNDLE}#${SETTINGS_NS}` });

				// The models page's per-provider seat, dispatched by the provider's
				// own settings namespace — which is this plugin's row id.
				seat("settings.models.provider-card", { key: SETTINGS_NS });
			} catch (error) {
				console.error("[dsh-minimax-connect] client page failed to load (host provider unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale", "configForms"];
		exports.name = "dsh-minimax-connect-client";
		return module.exports;
	},
});
