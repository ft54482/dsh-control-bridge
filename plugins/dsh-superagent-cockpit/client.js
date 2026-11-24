/**
 * dsh-superagent-cockpit —— client 半（纯 JS，ModuleLoader 包装）。
 *
 * 两个注册：
 *   sidebar.panellist / id=superagent-cockpit → 侧栏图标
 *   main / key=superagent-cockpit             → 驾驶舱页面
 *
 * 数据来自 Host 半的同源只读代理 /@dsh-superagent-cockpit/api/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-superagent-cockpit',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/@dsh-superagent-cockpit/api'
    const PANEL_ID = 'superagent-cockpit'
    const POLL_MS = 5000

    const TEXTS = {
      zh: {
        label: 'Super Agent 驾驶舱', title: 'SUPER AGENT', subtitle: '驾驶舱',
        running: '正在执行', idle: '没有正在执行的工单', slots: '执行器槽位',
        free: '空闲', busy: '执行中', queued: '排队',
        arrive: '24h 到达', judged: '已评估', accepted: '接单', exec: '执行器',
        evalFail: '评估失败', waitHuman: '等你处理',
        needYou: '需要人处理', none: '没有待处理问题', decisions: '最近决策',
        noDecision: '24h 内没有决策', sources: '来源与健康', updated: '更新',
        refresh: '刷新', openPanel: '完整面板', offline: '连不上 superagent',
        offlineHint: '确认 3082 上的 dsh-superagent 在跑，或改本插件 config.api。',
        evalTimeout: '评估失败', execError: '执行报错', failReason: '原因',
        statusRun: '运行中', statusPaused: '已暂停', statusWait: '等待部署检查',
        rounds: '轮', filtered: '条被过滤', evaluating: '条评估中', becameTicket: '成为工单',
        queuedSuffix: '排队', needLook: '需要人看一眼', waitingReply: '等你回话',
        accept: '接单', stop: '停止', runtime: '运行时', api: '127.0.0.1:3082',
        sparTitle: '仿真对练台', sparName: '仿真对练台', sparOnline: '在线', sparOffline: '离线',
        sparLedger: '账本', sparRunner: '对练进程', sparTrainer: '训练台', sparStats: '账本',
        sparIdle: '空闲', sparRunning: '对练中', sparUnknown: '未知',
        sparSeconds: '秒', sparCalls: '通', sparRounds: '轮', sparTurns: '句',
        sparPrompts: '版提示词', sparCostUnknown: '费用 unknown', sparStage: '阶段', sparRunId: 'run',
        sparCallsCumulative: '累计已打', sparCallsBudget: '本批预算', sparRoundsBatch: '本批合计', sparRunThis: '本轮',
        slotsInst: '工单执行器', slotsTickets: ' 张工单',
        slotsEmpty: '本实例没有在跑/排队的工单，槽位故为空',
        saTitle: '主控任务槽位',
        sparNoSession: '未登记会话',
        sparDeclare: '仿真 ≠ 生产接线 · 不接真实来电 · 费用 unknown 不写 0',
        sparDown: '请检查已配置的仿真服务。',
        sparHostMissing: '驾驶舱宿主还没加载 /sparring 端点（插件已改，需重载 DSH）· 也可能是瞬时网络错误，见下行原文',
        sparNotice: '声明',
      },
      en: {
        label: 'Super Agent cockpit', title: 'SUPER AGENT', subtitle: 'cockpit',
        running: 'Running now', idle: 'No ticket is running', slots: 'Executor slots',
        free: 'free', busy: 'running', queued: 'queued',
        arrive: '24h arrivals', judged: 'Evaluated', accepted: 'Accepted', exec: 'Executors',
        evalFail: 'Eval failures', waitHuman: 'Need you',
        needYou: 'Needs a person', none: 'Nothing needs you', decisions: 'Recent decisions',
        noDecision: 'No decision in 24h', sources: 'Sources & health', updated: 'Updated',
        refresh: 'Refresh', openPanel: 'Full panel', offline: 'superagent unreachable',
        offlineHint: 'Make sure dsh-superagent runs on 3082, or change this plugin config.api.',
        evalTimeout: 'Eval failed', execError: 'Execution error', failReason: 'reason',
        statusRun: 'Running', statusPaused: 'Paused', statusWait: 'Waiting for setup',
        rounds: 'rounds', filtered: 'filtered', evaluating: 'evaluating', becameTicket: 'became tickets',
        queuedSuffix: 'queued', needLook: 'needs a look', waitingReply: 'waiting on you',
        accept: 'accept', stop: 'stop', runtime: 'Runtime', api: '127.0.0.1:3082',
        sparTitle: 'Simulated sparring', sparName: 'Simulated sparring bench', sparOnline: 'online', sparOffline: 'offline',
        sparLedger: 'ledger', sparRunner: 'runner', sparTrainer: 'trainer', sparStats: 'ledger',
        sparIdle: 'idle', sparRunning: 'sparring', sparUnknown: 'unknown',
        sparSeconds: 's', sparCalls: 'calls', sparRounds: 'rounds', sparTurns: 'turns',
        sparPrompts: 'prompt versions', sparCostUnknown: 'cost unknown', sparStage: 'stage', sparRunId: 'run',
        sparCallsCumulative: 'cumulative calls', sparCallsBudget: 'batch budget', sparRoundsBatch: 'batch total', sparRunThis: 'this run',
        slotsInst: 'ticket executors', slotsTickets: ' open tickets',
        slotsEmpty: 'no running/queued tickets in this instance, so these slots are empty',
        saTitle: 'Master task slots',
        sparNoSession: 'no session registered',
        sparDeclare: 'Simulation ≠ production wiring · no real calls · unknown cost is never written as 0',
        sparDown: 'Check the configured simulation service.',
        sparHostMissing: 'the cockpit host has not loaded the /sparring endpoint yet (plugin changed, DSH reload required) · this can also be a transient network error, see the raw error below',
        sparNotice: 'notice',
      },
    }

    const langOf = ctx => {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        const active = locale && locale.getSnapshot ? locale.getSnapshot().active : ''
        return String(active || '').startsWith('en') ? 'en' : 'zh'
      } catch { return 'zh' }
    }

    const get = async path => {
      const res = await fetch(API + path, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(path + ' -> ' + res.status)
      return res.json()
    }

    const minutes = iso => {
      if (!iso) return '—'
      const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
      if (diff < 1) return '刚刚'
      if (diff < 60) return diff + ' 分钟前'
      if (diff < 1440) return Math.round(diff / 60) + ' 小时前'
      return Math.round(diff / 1440) + ' 天前'
    }
    const clock = iso => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
    const trim = (text, n) => {
      const s = String(text == null ? '' : text).replace(/\s+/g, ' ')
      return s.length > n ? s.slice(0, n) + '…' : s
    }

    const CSS = [
      '.sc-page{height:100%;overflow:auto;padding:22px 26px 28px;color:var(--dsw-alias-label-primary,#e8ecf3);background:var(--dsw-alias-bg-base,#0a0c11);font:14px/1.55 "Inter","Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
      '.sc-page *{box-sizing:border-box}',
      '.sc-head{display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--sc-line)}',
      '.sc-brand{display:flex;align-items:baseline;gap:9px}',
      '.sc-brand b{font-size:14px;letter-spacing:.2em;font-weight:600}',
      '.sc-brand span{font-size:12px;color:var(--sc-dim)}',
      '.sc-pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:999px;font-size:12px;border:1px solid rgba(53,224,192,.34);background:rgba(53,224,192,.08);color:#35e0c0;letter-spacing:.06em}',
      '.sc-pill.bad{border-color:rgba(255,107,107,.4);background:rgba(255,107,107,.09);color:#ff6b6b}',
      '.sc-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 9px currentColor;animation:sc-pulse 2s infinite}',
      '@keyframes sc-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.sc-right{margin-left:auto;display:flex;align-items:center;gap:12px;color:var(--sc-dim);font-size:12px}',
      '.sc-btn{cursor:pointer;border:1px solid var(--sc-line);background:var(--sc-card);color:var(--sc-mut);border-radius:7px;padding:5px 11px;font-size:12px;text-decoration:none}',
      '.sc-btn:hover{border-color:#323848;color:var(--dsw-alias-label-primary,#e8ecf3)}',
      '.sc-hero{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;margin-top:14px}',
      '.sc-card{background:var(--sc-card);border:1px solid var(--sc-line);border-radius:13px;padding:15px 17px}',
      '.sc-hot{border-color:rgba(53,224,192,.28);background:linear-gradient(150deg,rgba(53,224,192,.10),rgba(139,124,246,.05) 55%,transparent)}',
      '.sc-eyebrow{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--sc-dim)}',
      '.sc-big{display:flex;align-items:flex-end;gap:10px;margin:7px 0 5px}',
      '.sc-big .n{font-size:50px;line-height:1;font-weight:650;letter-spacing:-.02em;color:#7ef0dd}',
      '.sc-big .of{font-size:15px;color:var(--sc-dim);padding-bottom:6px}',
      '.sc-big .what{font-size:12.5px;color:var(--sc-mut);padding-bottom:7px}',
      '.sc-title{font-size:16px;font-weight:600;line-height:1.4}',
      '.sc-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}',
      '.sc-chip{font-size:11.5px;color:var(--sc-mut);border:1px solid var(--sc-line);border-radius:999px;padding:2px 9px}',
      '.sc-alert{margin-top:11px;border-left:2px solid #ff6b6b;background:rgba(255,107,107,.07);border-radius:0 8px 8px 0;padding:8px 11px;font-size:12.5px;color:#ffb3b3;line-height:1.5}',
      '.sc-lanes{display:grid;gap:7px;margin-top:9px}',
      '.sc-lane{display:flex;align-items:center;gap:9px;border:1px solid var(--sc-line);border-radius:9px;padding:8px 10px;font-size:12.5px;background:rgba(255,255,255,.015)}',
      '.sc-lane.run{border-color:rgba(53,224,192,.35);background:rgba(53,224,192,.07)}',
      '.sc-lane.free{border-style:dashed;color:var(--sc-dim)}',
      '.sc-idx{width:18px;height:18px;border-radius:5px;display:grid;place-items:center;font-size:10.5px;background:rgba(255,255,255,.06);color:var(--sc-mut);flex:none}',
      '.sc-lane.run .sc-idx{background:rgba(53,224,192,.18);color:#35e0c0}',
      '.sc-lane-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-lane-badge{font-size:10px;letter-spacing:.1em;color:#35e0c0}',
      '.sc-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:11px;margin-top:14px}',
      '.sc-kpi{border:1px solid var(--sc-line);border-radius:11px;padding:11px 13px;background:rgba(255,255,255,.018)}',
      '.sc-kpi-label{font-size:10.5px;letter-spacing:.12em;color:var(--sc-dim);text-transform:uppercase}',
      '.sc-kpi-value{font-size:25px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums}',
      '.sc-kpi-sub{font-size:11.5px;color:var(--sc-dim);margin-top:1px}',
      '.sc-kpi.warn .sc-kpi-value{color:#fbbf24}',
      '.sc-sect{display:flex;align-items:center;gap:10px;margin:18px 0 10px}',
      '.sc-sect h2{font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--sc-mut);font-weight:600}',
      '.sc-sect .count{font-size:11px;color:var(--sc-dim)}',
      '.sc-rule{flex:1;height:1px;background:var(--sc-line)}',
      '.sc-probs{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:11px}',
      '.sc-prob{border:1px solid var(--sc-line);border-left:2px solid #fbbf24;border-radius:11px;padding:11px 13px;background:rgba(255,255,255,.018)}',
      '.sc-prob.error{border-left-color:#ff6b6b}',
      '.sc-prob-head{display:flex;align-items:center;gap:8px;font-size:10.5px;letter-spacing:.1em}',
      '.sc-prob-tag{color:#fbbf24;border:1px solid rgba(251,191,36,.35);border-radius:5px;padding:1px 6px}',
      '.sc-prob.error .sc-prob-tag{color:#ff6b6b;border-color:rgba(255,107,107,.4)}',
      '.sc-prob-time{margin-left:auto;color:var(--sc-dim)}',
      '.sc-prob-title{font-size:13px;font-weight:600;margin-top:6px;line-height:1.4}',
      '.sc-prob-why{margin-top:5px;font-size:12px;color:var(--sc-mut);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.sc-cols{display:grid;grid-template-columns:1.1fr 1fr;gap:14px;margin-top:14px}',
      '.sc-decs{list-style:none;margin:10px 0 0;display:grid;gap:1px;padding:0}',
      '.sc-dec{display:flex;gap:10px;padding:7px 0 7px 2px;position:relative}',
      '.sc-dec:not(:last-child):after{content:"";position:absolute;left:5px;top:23px;bottom:-3px;width:1px;background:var(--sc-line)}',
      '.sc-dec-dot{width:11px;height:11px;border-radius:50%;margin-top:5px;background:#2b3242;flex:none}',
      '.sc-dec.ok .sc-dec-dot{background:#4ade80;box-shadow:0 0 8px rgba(74,222,128,.5)}',
      '.sc-dec.bad .sc-dec-dot{background:#ff6b6b;box-shadow:0 0 8px rgba(255,107,107,.5)}',
      '.sc-dec-head{display:flex;gap:9px;align-items:baseline;font-size:11px}',
      '.sc-dec.ok .sc-dec-kind{color:#4ade80}',
      '.sc-dec.bad .sc-dec-kind{color:#ff6b6b}',
      '.sc-dec.muted .sc-dec-kind{color:var(--sc-mut)}',
      '.sc-dec-time{color:var(--sc-dim)}',
      '.sc-dec-title{font-size:12.5px;margin-top:2px;line-height:1.45}',
      '.sc-dec-why{font-size:11px;color:var(--sc-dim)}',
      '.sc-src{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--sc-line);font-size:12.5px}',
      '.sc-src:last-child{border-bottom:none}',
      '.sc-src-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
      '.sc-src-name{font-weight:600}',
      '.sc-src-detail{margin-left:auto;color:var(--sc-dim);font-size:11.5px}',
      '.sc-sess{display:grid;margin-top:6px}',
      '.sc-srow{display:grid;grid-template-columns:10px 118px 1fr auto auto;gap:11px;align-items:center;padding:9px 2px;border-bottom:1px solid var(--sc-line);font-size:12.5px}',
      '.sc-srow:last-child{border-bottom:none}',
      '.sc-sdot{width:8px;height:8px;border-radius:50%;background:#454e60}',
      '.sc-sdot.run{background:#35e0c0;box-shadow:0 0 8px #35e0c0;animation:sc-pulse 2s infinite}',
      '.sc-sdot.person{background:#fbbf24;box-shadow:0 0 8px #fbbf24}',
      '.sc-sdot.main{background:#8b7cf6;box-shadow:0 0 8px #8b7cf6}',
      '.sc-sid{font-size:11.5px;color:var(--sc-mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-stitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-stag{font-size:10.5px;letter-spacing:.08em;border:1px solid var(--sc-line);border-radius:5px;padding:1px 7px;color:var(--sc-mut);white-space:nowrap}',
      '.sc-stag.run{color:#35e0c0;border-color:rgba(53,224,192,.35)}',
      '.sc-stag.person{color:#fbbf24;border-color:rgba(251,191,36,.35)}',
      '.sc-smeta{font-size:11px;color:var(--sc-dim);text-align:right;white-space:nowrap}',
      '.sc-rack{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:7px;margin-top:8px}',
      '.sc-cell{border:1px solid var(--sc-line);border-radius:8px;padding:8px 4px;text-align:center;font-size:10px;color:var(--sc-dim);background:rgba(255,255,255,.015)}',
      '.sc-cell b{display:block;font-size:11px;color:var(--sc-mut);font-weight:600;margin-bottom:2px}',
      '.sc-cell.running{border-color:rgba(53,224,192,.45);background:rgba(53,224,192,.09);box-shadow:0 0 14px rgba(53,224,192,.12)}',
      '.sc-cell.running b{color:#35e0c0}',
      '.sc-legend{display:flex;gap:14px;font-size:11px;color:var(--sc-dim);margin-top:9px}',
      '.sc-lg{display:inline-flex;align-items:center;gap:6px}',
      '.sc-lg i{width:7px;height:7px;border-radius:50%;background:#454e60;display:inline-block}',
      '.sc-lg.run i{background:#35e0c0;box-shadow:0 0 8px #35e0c0}',
      '.sc-foot{margin-top:16px;padding-top:11px;border-top:1px solid var(--sc-line);display:flex;gap:16px;color:var(--sc-dim);font-size:11.5px}',
      '.sc-mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-variant-numeric:tabular-nums}',
      '.sc-offline{border:1px dashed var(--sc-line);border-radius:13px;padding:28px;text-align:center;color:var(--sc-mut);margin-top:16px}',
      '.sc-fleet{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}',
      '.sc-fitem{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.sc-insthead{display:flex;align-items:center;gap:9px;min-width:0}',
      '.sc-badge{font-size:10px;letter-spacing:.06em;border:1px solid var(--sc-line);border-radius:5px;padding:1px 6px;color:var(--sc-mut);font-family:ui-monospace,"Cascadia Code",Consolas,monospace;flex:none}',
      '.sc-badge.on{color:#35e0c0;border-color:rgba(53,224,192,.35)}',
      '.sc-badge.off{color:#ff6b6b;border-color:rgba(255,107,107,.4)}',
      '.sc-mini{display:grid}',
      '.sc-mrow{display:grid;grid-template-columns:9px 1fr auto;gap:9px;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid var(--sc-line);min-width:0}',
      '.sc-mrow:last-child{border-bottom:none}',
      '.sc-kpis.six{grid-template-columns:repeat(3,1fr)}',
      '.sc-sdot.ok{background:#4ade80;box-shadow:0 0 8px #4ade80}',
      '.sc-sdot.bad{background:#ff6b6b;box-shadow:0 0 8px #ff6b6b}',
      '.sc-stag.ok{color:#4ade80;border-color:rgba(74,222,128,.35)}',
      '.sc-stag.bad{color:#ff6b6b;border-color:rgba(255,107,107,.4)}',
      '.sc-sa-mission{font-size:11px;color:var(--sc-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
    ].join('\n')

    const vars = {
      '--sc-card': 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.028))',
      '--sc-line': 'var(--dsw-alias-border-l2, #1e2330)',
      '--sc-mut': 'var(--dsw-alias-label-secondary, #8b93a5)',
      '--sc-dim': 'var(--dsw-alias-label-caption, #5f6878)',
    }

    function Icon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', 'aria-hidden': true,
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M12 3a9 9 0 1 0 9 9' }),
      h('path', { d: 'M12 12l4.5-4.5' }),
      h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }))
    }

    function Kpi({ label, value, sub, tone }) {
      return h('div', { className: 'sc-kpi' + (tone ? ' ' + tone : '') },
        h('div', { className: 'sc-kpi-label' }, label),
        h('div', { className: 'sc-kpi-value' }, value),
        h('div', { className: 'sc-kpi-sub' }, sub))
    }

    const STAGE_LABEL = { working: '执行中', person: '等你处理', queued: '排队', idle: '空闲' }
    const STAGE_CLS = { working: 'run', person: 'person' }
    const SA_STATUS = {
      created: '已创建', working: '开发中', auditing: '审计中', rework: '返修中',
      accepted: '已验收', blocked: '已阻塞', paused: '已暂停',
    }
    const SA_CLS = { working: 'run', auditing: 'person', rework: 'person', accepted: 'ok', blocked: 'bad' }
    const SA_ACTIVE = new Set(['created', 'working', 'auditing', 'rework'])

    /** 一个 superagent 实例的自包含卡片：它的槽位、6 个 KPI、打开中的工单。 */
    function InstanceCard({ ins, t }) {
      const ok = ins && ins.ok
      const head = h('div', { className: 'sc-insthead' },
        h('span', { className: 'sc-badge ' + (ok ? 'on' : 'off') }, (ins && ins.id) || '?'),
        h('span', { className: 'sc-stitle', style: { fontWeight: 600 } }, (ins && ins.label) || ''),
        h('span', { className: 'sc-stag ' + (ok ? 'run' : '') }, ok ? t.statusRun : '离线'),
        h('a', {
          className: 'sc-btn', style: { marginLeft: 'auto' },
          href: 'http://127.0.0.1:' + ((ins && ins.id) || '') + '/', target: '_blank', rel: 'noreferrer',
        }, t.openPanel))
      if (!ok) {
        return h('div', { className: 'sc-fitem' }, head,
          h('div', { className: 'sc-card' }, h('div', { className: 'sc-alert' }, (ins && ins.error) || t.offline)))
      }
      const ex = (ins.overview && ins.overview.executor) || {}
      const running = ex.running ?? '—'
      const maxWorkers = ex.maxWorkers ?? '—'
      const queued = ex.queued ?? '—'
      const open = (ins.tickets && ins.tickets.items) || []
      const flow = (ins.overview && ins.overview.flow) || {}
      const problems = (ins.overview && ins.overview.problems) || []
      const heroTicket = open.find(item => item.stage === 'working') || open[0] || null
      const lanes = []
      for (let i = 0; i < maxWorkers; i += 1) {
        const occupied = Number.isInteger(running) && i < running
        lanes.push(h('div', { key: 'il' + i, className: 'sc-lane ' + (occupied ? 'run' : 'free') },
          h('span', { className: 'sc-idx sc-mono' }, i + 1),
          h('span', { className: 'sc-lane-title' }, Number.isInteger(running) ? (occupied ? t.busy : t.free) : t.sparUnknown)))
      }
      return h('div', { className: 'sc-fitem' }, head,
        h('div', { className: 'sc-card sc-hot' },
          h('div', { className: 'sc-big' },
            h('span', { className: 'n sc-mono' }, running),
            h('span', { className: 'of sc-mono' }, '/ ' + maxWorkers),
            h('span', { className: 'what' }, queued > 0 ? queued + ' ' + t.queuedSuffix : running > 0 ? t.busy : running === 0 ? t.free : '—')),
          h('div', { className: 'sc-title', style: heroTicket ? null : { color: 'var(--sc-dim)' } },
            heroTicket ? heroTicket.title : t.idle),
          heroTicket ? h('div', { className: 'sc-chips' },
            h('span', { className: 'sc-chip sc-mono' }, (heroTicket.assignments == null ? 0 : heroTicket.assignments) + ' ' + t.rounds),
            h('span', { className: 'sc-chip sc-mono' }, minutes(heroTicket.updatedAt))) : null),
        h('div', { className: 'sc-card' },
          // 这里的槽位是「工单执行器」（本实例的 overview.executor），跟主控那边的 Super Agent lane 不是一回事。
          h('div', { className: 'sc-eyebrow' }, t.slotsInst + '（本实例 ' + open.length + t.slotsTickets + '）'),
          h('div', { className: 'sc-lanes' }, lanes.length ? lanes : h('div', { className: 'sc-lane free' }, '—')),
          open.length === 0
            ? h('div', { style: { marginTop: 7, fontSize: 11.5, color: 'var(--sc-dim)' } }, t.slotsEmpty)
            : null),
        h('div', { className: 'sc-kpis six' },
          h(Kpi, { label: t.arrive, value: flow.received || 0, sub: (flow.filtered || 0) + ' ' + t.filtered }),
          h(Kpi, { label: t.accepted, value: flow.accepted || 0, sub: t.becameTicket }),
          h(Kpi, { label: t.waitHuman, value: open.filter(item => item.stage === 'person').length, sub: t.waitingReply }),
          h(Kpi, { label: t.exec, value: running + '/' + maxWorkers, sub: queued + ' ' + t.queuedSuffix }),
          h(Kpi, { label: t.evalFail, value: problems.length, sub: t.needLook, tone: problems.length ? 'warn' : '' }),
          h(Kpi, { label: t.judged, value: flow.judged || 0, sub: (flow.evaluating || 0) + ' ' + t.evaluating })),
        h('div', { className: 'sc-card' }, h('div', { className: 'sc-mini' },
          open.length
            ? open.slice(0, 6).map((ticket, index) => h('div', { key: 'im' + index, className: 'sc-mrow' },
              h('span', { className: 'sc-sdot ' + (STAGE_CLS[ticket.stage] || '') }),
              h('span', { className: 'sc-stitle', title: ticket.title }, ticket.title),
              h('span', { className: 'sc-stag ' + (STAGE_CLS[ticket.stage] || '') },
                STAGE_LABEL[ticket.stage] || ticket.stage || '—')))
            : h('div', { style: { color: 'var(--sc-dim)', fontSize: 12 } }, '没有打开的工单'))))
    }

    function Page(props) {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [at, setAt] = React.useState('')
      const lang = langOf(props && props.__ctx)
      const t = TEXTS[lang]

      const polling = React.useRef(false)
      const load = React.useCallback(async () => {
        if (polling.current) return
        polling.current = true
        try {
          const optional = path => get(path).catch(() => null)
          const [primary, settings, cluster, superagents, spar, fleet] = await Promise.all([
            Promise.all([
              get('/state'), get('/overview'), get('/tickets?state=open'), get('/tickets?state=ended'),
              get('/sources'), get('/decisions?window=24h'),
            ]).catch(() => null),
            optional('/settings'), optional('/cluster'), optional('/superagents'),
            get('/sparring').then(value => ({ value }), error => ({ error: String(error) })),
            optional('/fleet'),
          ])
          const [state, overview, tickets, ended, sources, decisions] = primary || [{}, {}, {}, {}, [], {}]
          const sparring = spar.value || null
          const sparringError = spar.error || ''
          setData({ state, overview, tickets, ended, sources, decisions, settings, primaryReady: !!primary, cluster, superagents, sparring, sparringError, fleet })
          setErr('')
          setAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        } catch (error) {
          setErr(String(error && error.message ? error.message : error))
        } finally {
          polling.current = false
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      if (!data) {
        const offline = h('div', { className: 'sc-offline' },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, err ? t.offline : '…'),
          err ? h('div', { style: { marginTop: 6, fontSize: 12.5 } }, t.offlineHint) : null,
          err ? h('div', { className: 'sc-mono', style: { marginTop: 10, fontSize: 11.5, opacity: 0.7 } }, err) : null,
          h('div', { style: { marginTop: 14 } }, h('button', { className: 'sc-btn', onClick: load }, t.refresh)))
        return h('div', { className: 'sc-page', style: vars }, h('style', null, CSS), offline)
      }

      const { state, overview, tickets, ended, sources, decisions, settings, primaryReady, cluster, superagents, sparring, sparringError, fleet } = data
      const panelUrl = settings?.api || null
      const primaryId = panelUrl ? new URL(panelUrl).host : '—'
      const fleetList = fleet && fleet.instances && fleet.instances.length ? fleet.instances : null
      const load0 = overview.executor || {}
      const running = load0.running ?? '—'
      const maxWorkers = load0.maxWorkers ?? '—'
      const queued = load0.queued ?? '—'
      const flow = overview.flow || {}
      const problems = overview.problems || []
      const openTickets = tickets.items || []
      const endedTickets = (ended && ended.items) || []
      const failed = openTickets.filter(item => /LlmError|Error:/i.test(String(item.summary || '')))
      const decs = decisions.items || []
      const paused = state.paused === true
      const runtimeState = state.health && state.health.runtime ? state.health.runtime.state : 'ready'
      const badRuntime = !primaryReady || runtimeState !== 'ready'
      const heroTicket = openTickets.find(item => item.stage === 'working') || openTickets[0] || null

      /* --- 头部 --- */
      const fleetOnline = fleetList ? fleetList.filter(ins => ins.ok).length : 0
      const head = h('header', { className: 'sc-head' },
        h('div', { className: 'sc-brand' }, h('b', null, t.title), h('span', null, t.subtitle)),
        h('div', { className: 'sc-pill' + (fleetList ? (fleetOnline === fleetList.length ? '' : ' bad') : (paused || badRuntime ? ' bad' : '')) },
          h('i', { className: 'sc-dot' }),
          fleetList
            ? fleetOnline + '/' + fleetList.length + ' 实例在线'
            : (paused ? t.statusPaused : badRuntime ? t.statusWait : t.statusRun)),
        h('div', { className: 'sc-right' },
          h('span', { className: 'sc-mono' }, t.updated + ' ' + (at || '—')),
          h('button', { className: 'sc-btn', onClick: load }, t.refresh),
          panelUrl ? h('a', { className: 'sc-btn', href: panelUrl, target: '_blank', rel: 'noreferrer' }, t.openPanel) : null))

      /* --- 槽位 --- */
      const lanes = []
      for (let i = 0; i < maxWorkers; i += 1) {
        const occupied = Number.isInteger(running) && i < running
        lanes.push(h('div', { key: 'lane' + i, className: 'sc-lane ' + (occupied ? 'run' : 'free') },
          h('span', { className: 'sc-idx sc-mono' }, i + 1),
          h('span', { className: 'sc-lane-title' }, Number.isInteger(running) ? (occupied ? t.busy : t.free) : t.sparUnknown)))
      }

      /* --- 首屏 --- */
      const hero = h('section', { className: 'sc-hero' },
        h('div', { className: 'sc-card sc-hot' },
          h('div', { className: 'sc-eyebrow' }, t.running),
          h('div', { className: 'sc-big' },
            h('span', { className: 'n sc-mono' }, running),
            h('span', { className: 'of sc-mono' }, '/ ' + maxWorkers),
            h('span', { className: 'what' }, queued > 0 ? queued + ' ' + t.queuedSuffix : running > 0 ? t.busy : running === 0 ? t.free : '—')),
          h('div', { className: 'sc-title', style: heroTicket ? null : { color: 'var(--sc-dim)' } },
            heroTicket ? heroTicket.title : t.idle),
          heroTicket ? h('div', { className: 'sc-chips' },
            h('span', { className: 'sc-chip sc-mono' }, (heroTicket.assignments == null ? 0 : heroTicket.assignments) + ' ' + t.rounds),
            h('span', { className: 'sc-chip sc-mono' }, minutes(heroTicket.updatedAt)),
            heroTicket.threads && heroTicket.threads[0]
              ? h('span', { className: 'sc-chip' }, heroTicket.threads[0].title)
              : null) : null,
          failed[0]
            ? h('div', { className: 'sc-alert' }, h('b', null, t.failReason + '：'), trim(failed[0].summary, 200))
            : null),
        h('div', { className: 'sc-card' },
          h('div', { className: 'sc-eyebrow' }, t.slots),
          h('div', { className: 'sc-lanes' }, lanes)))

      /* --- KPI --- */
      const kpis = h('section', { className: 'sc-kpis' },
        h(Kpi, { label: t.arrive, value: flow.received || 0, sub: (flow.filtered || 0) + ' ' + t.filtered }),
        h(Kpi, { label: t.judged, value: flow.judged || 0, sub: (flow.evaluating || 0) + ' ' + t.evaluating }),
        h(Kpi, { label: t.accepted, value: flow.accepted || 0, sub: t.becameTicket }),
        h(Kpi, { label: t.exec, value: running + '/' + maxWorkers, sub: queued + ' ' + t.queuedSuffix }),
        h(Kpi, { label: t.evalFail, value: problems.length, sub: t.needLook, tone: problems.length ? 'warn' : '' }),
        h(Kpi, { label: t.waitHuman, value: openTickets.filter(item => item.stage === 'person').length, sub: t.waitingReply }))

      /* --- 主控 · Super Agents（masterctl.mjs 写注册表，驾驶舱只读） --- */
      // 集群活代理：注册表说「开发中」不代表进程里真有会话，两边的差要摆在同一行给人看。
      const clusterKnown = cluster?.agentsKnown === true
      const liveAgents = clusterKnown ? cluster.agents : []
      const liveRunning = liveAgents.filter(agent => agent.phase === 'running').length
      const normSid = value => String(value || '').replace(/^session-/, '')
      const matchLive = sid => {
        const key = normSid(sid)
        if (!key) return null
        return liveAgents.find(item => item.id === sid || item.id === 'session-' + key || normSid(item.id) === key) || null
      }
      // 四态：注册表没给 sessionId（自己的缺口）/ 匹配到在跑 / 匹配到没在跑 / 匹配不到
      const liveTag = agent => {
        const sid = agent && agent.sessionId
        if (!sid) return { text: t.sparNoSession || '未登记会话', cls: 'person' }
        if (!clusterKnown) return { text: '会话未知', cls: '' }
        const hit = matchLive(sid)
        if (!hit) return { text: '无活会话', cls: 'bad' }
        return hit.phase === 'running' ? { text: '在线', cls: 'ok' } : { text: '不在跑', cls: 'person' }
      }
      // 取到了就别叫唤：只有「真的没取到」才把 probe 原文摆出来。
      //   !agentsVia                      → 服务没解析到
      //   agentsShape 存在且非 unresolved/array → 形状异常
      //   counts.total > 0                → 一律不显示（已有活代理，噪音没意义）
      const clusterProbe = (cluster && cluster.probe) || null
      const clusterCounts = (cluster && cluster.counts) || null
      const clusterTotalRaw = clusterCounts ? Number(clusterCounts.total) : NaN
      const clusterTotal = Number.isFinite(clusterTotalRaw) ? clusterTotalRaw : null
      const probeHasVia = !!(clusterProbe && clusterProbe.agentsVia)
      const probeShapeAnomaly = !!(clusterProbe && clusterProbe.agentsShape
        && clusterProbe.agentsShape !== 'unresolved' && clusterProbe.agentsShape !== 'array')
      const probeWorthShowing = (!probeHasVia || probeShapeAnomaly) && !(clusterTotal != null && clusterTotal > 0)
      const clusterProbeError = probeWorthShowing && clusterProbe
        ? String(clusterProbe.agentsError || clusterProbe.agentsShape || clusterProbe.jobsError || '')
        : ''
      const sa = superagents || {}
      const registryKnown = sa.ok === true
      const saAgents = Array.isArray(sa.agents) ? sa.agents.slice() : []
      const saActive = saAgents.filter(agent => SA_ACTIVE.has(String(agent.status)))
      const saAccepted = saAgents.filter(agent => agent.status === 'accepted').length
      const saCapacity = registryKnown ? sa.maxWorkers : null
      const saByLane = new Map()
      for (const agent of saActive) {
        const lane = Number(agent.lane)
        if (Number.isInteger(lane) && lane > 0) saByLane.set(lane, agent)
      }
      const saLanes = []
      for (let lane = 1; lane <= saCapacity; lane += 1) {
        const agent = saByLane.get(lane)
        saLanes.push(h('div', { key: 'sal' + lane, className: 'sc-lane ' + (agent ? 'run' : 'free') },
          h('span', { className: 'sc-idx sc-mono' }, lane),
          h('span', { className: 'sc-lane-title' }, agent ? agent.title : '空闲'),
          agent ? h('span', { className: 'sc-lane-badge' }, SA_STATUS[agent.status] || agent.status) : null))
      }
      const saRows = saAgents.length
        ? saAgents
          .slice()
          .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
          .slice(0, 10)
          .map(agent => {
            const cls = SA_CLS[agent.status] || ''
            return h('div', { key: 'sa' + agent.id, className: 'sc-srow' },
              h('span', { className: 'sc-sdot ' + cls }),
              h('span', { className: 'sc-sid sc-mono', title: String(agent.sessionId || '') },
                'L' + (agent.lane || '-') + ' ' + String(agent.id || '').slice(0, 12)),
              h('div', { style: { minWidth: 0 } },
                h('div', { className: 'sc-stitle', title: agent.title }, agent.title || agent.id),
                h('div', { className: 'sc-sa-mission', title: agent.mission || '' }, agent.mission || '—')),
              h('span', { className: 'sc-stag ' + cls }, SA_STATUS[agent.status] || agent.status || '—'),
              h('span', { className: 'sc-smeta sc-mono', style: { whiteSpace: 'nowrap' } },
                'r' + (agent.round == null ? 0 : agent.round) + '/' + (agent.maxRounds || 3) +
                ' · ' + (agent.lastVerdict || '—') + ' · ' + minutes(agent.updatedAt),
                h('span', {
                  className: 'sc-stag ' + liveTag(agent).cls,
                  style: { marginLeft: 6 },
                  title: clusterKnown ? '与 /cluster 活代理按 sessionId 比对' : (clusterProbeError || '/cluster 没拿到活代理列表，无法比对'),
                }, liveTag(agent).text)))
          })
        : [h('div', { key: 'sa-none', className: 'sc-srow' },
          h('span', { className: 'sc-sdot' }),
          h('span', { className: 'sc-sid sc-mono' }, '—'),
          h('span', { className: 'sc-stitle', style: { color: 'var(--sc-dim)' } }, registryKnown ? '尚无登记任务' : '主控登记表不可用'),
          h('span', { className: 'sc-stag' }, registryKnown ? '空闲' : '未知'),
          h('span', { className: 'sc-smeta sc-mono' }, 'masterctl.mjs'))]

      const saSection = h('section', null,
        h('div', { className: 'sc-sect' },
          h('h2', null, t.saTitle),
          h('span', { className: 'count' },
            registryKnown ? saActive.length + '/' + saCapacity + ' 个登记任务 · ' + saAccepted + ' 已验收' +
            (sa.project ? ' · ' + sa.project : '') : '登记表未知'),
          h('span', {
            className: 'count',
            style: { color: liveRunning > 0 ? '#35e0c0' : 'var(--sc-dim)' },
            title: clusterKnown ? '本 DSH 进程里 phase=running 的 agent 数' : '/cluster 没拿到，活代理未知',
          }, 'Harness 运行中会话 ' + (clusterKnown ? liveRunning : '—')),
          clusterProbeError
            ? h('span', {
              className: 'sc-stag bad',
              title: clusterProbeError,
              style: { maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, '/cluster probe: ' + trim(clusterProbeError, 120))
            : null,
          h('div', { className: 'sc-rule' })),
        h('div', { className: 'sc-card' },
          h('div', { className: 'sc-lanes' }, saLanes),
          h('div', { className: 'sc-sess', style: { marginTop: 8 } }, saRows)),
        (clusterKnown && saActive.length > 0 && liveAgents.length === 0)
          ? h('div', { className: 'sc-card', style: { marginTop: 10 } },
            h('div', { className: 'sc-alert' },
              '集群枚举为 0：/cluster 未返回任何活代理，注册表的"开发中"无法交叉验证'))
          : null)

      /* --- 对练台 · 8770（仿真对练台，不属于 DSH 子代理体系；Host 半服务端读它的只读接口） --- */
      const sp = sparring || null
      const spOk = !!(sp && sp.ok === true)
      const spRunner = (sp && sp.runner) || null
      const spTrainer = (sp && sp.trainer) || null
      const spStats = (sp && sp.stats) || null
      const spBase = (sp && typeof sp.base === 'string' && sp.base) ? sp.base : 'http://127.0.0.1:8770'
      const spNum = value => (value == null ? '—' : String(value))
      const spRatio = (a, b) => spNum(a) + '/' + spNum(b)
      const spState = value => (value === 'running' ? t.sparRunning
        : value === 'idle' ? t.sparIdle
          : (typeof value === 'string' && value ? value : t.sparUnknown))
      const spTime = iso => {
        if (!iso) return '—'
        const at = new Date(iso)
        return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString('zh-CN', { hour12: false })
      }
      const spLedger = spTrainer && spTrainer.ledgerRounds != null ? spTrainer.ledgerRounds
        : (spStats && spStats.rounds != null ? spStats.rounds : null)
      const spWarnings = (sp && Array.isArray(sp.warnings)) ? sp.warnings : []
      const spRows = []
      spRows.push(h('div', { key: 'sp-head', className: 'sc-srow' },
        h('span', { className: 'sc-sdot ' + (spOk ? 'run' : 'bad') }),
        h('span', { className: 'sc-sid sc-mono', title: spBase }, 'L- ' + spNum(sp && sp.port)),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'sc-stitle' }, t.sparName),
          h('div', { className: 'sc-sa-mission', title: (sp && typeof sp.banner === 'string' ? sp.banner : '') },
            (sp && typeof sp.banner === 'string' && sp.banner) ? trim(sp.banner, 72) : '—')),
        h('span', { className: 'sc-stag ' + (spOk ? 'ok' : 'bad') }, spOk ? t.sparOnline : t.sparOffline),
        h('span', { className: 'sc-smeta sc-mono' }, spBase + ' · ' + spTime(sp && sp.checkedAt))))
      spRows.push(h('div', { key: 'sp-run', className: 'sc-srow' },
        h('span', { className: 'sc-sdot ' + (spRunner && spRunner.state === 'running' ? 'run' : '') }),
        h('span', { className: 'sc-sid sc-mono' }, t.sparRunner),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'sc-stitle' }, spRunner ? spState(spRunner.state) : t.sparUnknown),
          h('div', { className: 'sc-sa-mission' },
            spRunner ? spRatio(spRunner.elapsed, spRunner.maxSeconds) + ' ' + t.sparSeconds : '—')),
        // 累计已打 与 本批预算 是两个不同口径的数，不能印成 38/8（看起来像超预算还在跑）。
        h('span', { style: { display: 'inline-flex', gap: 6, flexWrap: 'wrap' } },
          h('span', { className: 'sc-stag ' + (spRunner && spRunner.state === 'running' ? 'run' : '') },
            spRunner ? t.sparCallsCumulative + ' ' + spNum(spRunner.callsDone) + ' ' + t.sparCalls : '—'),
          spRunner
            ? h('span', { className: 'sc-stag' }, t.sparCallsBudget + ' ' + spNum(spRunner.callsBudget) + ' ' + t.sparCalls)
            : null),
        h('span', { className: 'sc-smeta sc-mono' },
          spRunner
            ? t.sparRoundsBatch + ' ' + spNum(spRunner.rounds) + ' ' + t.sparTurns
              + (spRunner.runId ? ' · ' + t.sparRunThis + ' ' + spRunner.runId : '')
            : '—')))
      spRows.push(h('div', { key: 'sp-train', className: 'sc-srow' },
        h('span', { className: 'sc-sdot ' + (spTrainer && spTrainer.state === 'running' ? 'run' : '') }),
        h('span', { className: 'sc-sid sc-mono' }, t.sparTrainer),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'sc-stitle' }, spTrainer ? spState(spTrainer.state) : t.sparUnknown),
          h('div', { className: 'sc-sa-mission' },
            spTrainer ? t.sparStage + ' ' + spNum(spTrainer.stageIndex) + ' · '
              + spNum(spTrainer.elapsed) + ' ' + t.sparSeconds : '—')),
        h('span', { className: 'sc-stag' },
          spTrainer ? spRatio(spTrainer.ledgerRounds, spTrainer.ledgerMaxRound) + ' ' + t.sparRounds : '—'),
        h('span', { className: 'sc-smeta sc-mono' },
          spTrainer ? t.sparLedger + ' ' + spNum(spTrainer.ledgerRounds) + ' ' + t.sparRounds : '—')))
      spRows.push(h('div', { key: 'sp-stats', className: 'sc-srow' },
        h('span', { className: 'sc-sdot' }),
        h('span', { className: 'sc-sid sc-mono' }, t.sparStats),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'sc-stitle' },
            spStats ? spNum(spStats.rounds) + ' ' + t.sparRounds + t.sparLedger : '—'),
          h('div', { className: 'sc-sa-mission', title: spStats && spStats.costNote ? spStats.costNote : '' },
            spStats ? spNum(spStats.prompts) + ' ' + t.sparPrompts : '—')),
        h('span', { className: 'sc-stag' }, spStats ? spNum(spStats.calls) + ' ' + t.sparCalls : '—'),
        h('span', { className: 'sc-smeta sc-mono' },
          spStats
            ? (spStats.costUnknown ? t.sparCostUnknown : (spStats.costNote || t.sparUnknown))
            : '—')))
      if (!spOk) {
        // 两种离线别混：宿主没这个端点（插件没重载）≠ 8770 挂了。冤枉 8770 是撒谎。
        const spHostMissing = !sp
        const spDetail = spHostMissing ? t.sparHostMissing : t.sparDown
        const spErrText = spHostMissing
          ? (typeof sparringError === 'string' ? sparringError : '')
          : (sp && typeof sp.error === 'string' ? sp.error : '')
        spRows.push(h('div', { key: 'sp-down', className: 'sc-srow', style: { gridTemplateColumns: '10px 118px 1fr' } },
          h('span', { className: 'sc-sdot bad' }),
          h('span', { className: 'sc-sid sc-mono' }, spHostMissing ? '/sparring' : 'port ' + spNum(sp && sp.port)),
          h('div', { style: { minWidth: 0, fontSize: 12, color: 'var(--sc-mut)', lineHeight: 1.5 } },
            h('div', { style: { whiteSpace: 'normal' } }, spDetail),
            spErrText
              ? h('div', {
                className: 'sc-mono',
                style: { marginTop: 4, fontSize: 11.5, opacity: 0.75, whiteSpace: 'normal' },
              }, trim(spErrText, 160))
              : null)))
      }
      if (spOk && spWarnings.length) {
        spRows.push(h('div', { key: 'sp-warn', className: 'sc-srow', style: { gridTemplateColumns: '10px 118px 1fr' } },
          h('span', { className: 'sc-sdot person' }),
          h('span', { className: 'sc-sid sc-mono' }, 'warnings ' + spWarnings.length),
          h('div', {
            className: 'sc-mono',
            style: { minWidth: 0, fontSize: 11.5, color: 'var(--sc-mut)', whiteSpace: 'normal' },
          }, trim(spWarnings.join(' · '), 220))))
      }
      spRows.push(h('div', { key: 'sp-notice', className: 'sc-srow', style: { gridTemplateColumns: '10px 118px 1fr' } },
        h('span', { className: 'sc-sdot' }),
        h('span', { className: 'sc-sid sc-mono' }, t.sparNotice),
        h('div', { className: 'sc-stitle', style: { whiteSpace: 'normal', color: 'var(--sc-mut)' } }, t.sparDeclare)))

      const sparringSection = h('section', null,
        h('div', { className: 'sc-sect' },
          h('h2', null, t.sparTitle),
          h('span', { className: 'count' },
            spOk
              ? t.sparOnline + ' · ' + t.sparLedger + ' ' + spNum(spLedger) + ' ' + t.sparRounds
              : t.sparOffline),
          h('div', { className: 'sc-rule' })),
        h('div', { className: 'sc-card' }, h('div', { className: 'sc-sess' }, spRows)))

      /* --- 需要人处理 --- */
      const cards = problems.map(item => ({
        sev: 'warn',
        tag: item.kind === 'eval-unavailable' ? t.evalTimeout : item.kind,
        title: (item.thread && item.thread.title) || (item.thread && item.thread.key) || '—',
        why: (item.reason || []).map(reason => reason.code).join(' · '),
        at: item.thread && item.thread.lastAt,
      })).concat(failed.map(item => ({
        sev: 'error',
        tag: t.execError,
        title: item.title,
        why: item.summary,
        at: item.updatedAt,
      })))

      const problemCards = cards.length
        ? cards.map((card, index) => h('div', { key: 'prob' + index, className: 'sc-prob ' + card.sev },
          h('div', { className: 'sc-prob-head' },
            h('span', { className: 'sc-prob-tag' }, card.tag),
            h('span', { className: 'sc-prob-time sc-mono' }, minutes(card.at))),
          h('div', { className: 'sc-prob-title' }, card.title),
          h('div', { className: 'sc-prob-why' }, card.why)))
        : [h('div', { key: 'prob-none', className: 'sc-prob', style: { borderLeftColor: '#4ade80' } },
          h('div', { className: 'sc-prob-title', style: { color: 'var(--sc-dim)' } }, t.none))]

      const probs = h('section', { className: 'sc-probs' }, problemCards)

      const sect = h('div', { className: 'sc-sect' },
        h('h2', null, t.needYou),
        h('span', { className: 'count' }, cards.length),
        h('div', { className: 'sc-rule' }))

      /* --- 决策 --- */
      const decItems = decs.length
        ? decs.slice(0, 7).map((dec, index) => {
          const kind = dec.kind || dec.outcome
          const cls = kind === 'accept' ? 'ok' : kind === 'stop' ? 'muted' : 'bad'
          const label = kind === 'accept' ? t.accept : kind === 'stop' ? t.stop : kind === 'unavailable' ? t.evalTimeout : kind
          return h('li', { key: 'dec' + index, className: 'sc-dec ' + cls },
            h('span', { className: 'sc-dec-dot' }),
            h('div', null,
              h('div', { className: 'sc-dec-head' },
                h('span', { className: 'sc-dec-kind' }, label),
                h('span', { className: 'sc-dec-time sc-mono' }, clock(dec.at))),
              h('div', { className: 'sc-dec-title' }, dec.ticketTitle || dec.threadTitle || dec.thread || ''),
              h('div', { className: 'sc-dec-why' }, (dec.reason || []).map(reason => reason.code).join(' · '))))
        })
        : [h('li', { key: 'dec-none', className: 'sc-dec' },
          h('div', { className: 'sc-dec-title', style: { color: 'var(--sc-dim)' } }, t.noDecision))]

      /* --- 来源 --- */
      const sourceRows = (sources || []).map((source, index) => h('div', { key: 'src' + index, className: 'sc-src' },
        h('span', { className: 'sc-src-dot', style: { color: source.state === 'ready' ? '#4ade80' : '#fbbf24' } }),
        h('span', { className: 'sc-src-name' }, (source.title && (source.title.zh || source.title.en)) || source.id),
        h('span', { className: 'sc-src-detail' }, (source.health && source.health[0] && source.health[0].detail) || source.state)))
      sourceRows.push(h('div', { key: 'src-runtime', className: 'sc-src' },
        h('span', { className: 'sc-src-dot', style: { color: '#8b7cf6' } }),
        h('span', { className: 'sc-src-name' }, t.runtime),
        h('span', { className: 'sc-src-detail' }, (state.health && state.health.runtime && state.health.runtime.detail) || '—')))

      /* --- 会话 --- */
      const stageLabel = stage => stage === 'working' ? '执行中'
        : stage === 'person' ? '等你处理'
          : stage === 'queued' ? '排队' : stage === 'idle' ? '空闲' : (stage || '—')
      const stageCls = stage => stage === 'working' ? 'run' : stage === 'person' ? 'person' : ''

      const sessionRow = (ticket, isEnded) => h('div', { key: 'sess-' + (ticket.id || ticket.title), className: 'sc-srow' },
        h('span', { className: 'sc-sdot ' + (isEnded ? '' : stageCls(ticket.stage)) }),
        h('span', { className: 'sc-sid sc-mono', title: String(ticket.sessionId || '') },
          String(ticket.sessionId || '').slice(0, 15) + '…'),
        h('span', { className: 'sc-stitle' }, ticket.title),
        h('span', { className: 'sc-stag ' + (isEnded ? '' : stageCls(ticket.stage)) }, isEnded ? '已结束' : stageLabel(ticket.stage)),
        h('span', { className: 'sc-smeta sc-mono' },
          (ticket.assignments == null ? 0 : ticket.assignments) + ' ' + t.rounds + ' · ' + minutes(ticket.updatedAt)))

      const sessionRows = [
        h('div', { key: 'sess-main', className: 'sc-srow' },
          h('span', { className: 'sc-sdot main' }),
          h('span', { className: 'sc-sid sc-mono', title: String(state.masterId || '') }, String(state.masterId || '').slice(0, 15) + '…'),
          h('span', { className: 'sc-stitle' }, '主会话 · 路由与编排'),
          h('span', { className: 'sc-stag ' + (badRuntime ? '' : 'run') }, badRuntime ? t.statusWait : '在线'),
          h('span', { className: 'sc-smeta sc-mono' }, '派发 · 评估 · 回复')),
        ...openTickets.map(ticket => sessionRow(ticket, false)),
        ...endedTickets.slice(0, 3).map(ticket => sessionRow(ticket, true)),
      ]

      const sessions = h('section', null,
        h('div', { className: 'sc-sect' },
          h('span', { className: 'sc-badge' }, primaryId),
          h('h2', null, '会话'),
          h('span', { className: 'count' }, openTickets.length + ' 张打开工单'),
          h('div', { className: 'sc-rule' })),
        h('div', { className: 'sc-card' }, h('div', { className: 'sc-sess' }, sessionRows)))

      /* --- 集群 --- */
      const cl = cluster || {}
      const clusterCells = (cl.agents || []).map((agent, index) => h('div', {
        key: 'cell' + index,
        className: 'sc-cell' + (agent.phase === 'running' ? ' running' : ''),
        title: [agent.id, agent.cwd, agent.preset].filter(Boolean).join('\n'),
      },
      h('b', { className: 'sc-mono' }, String(agent.id || '').replace(/^session-/, '').slice(0, 8)),
      agent.phase === 'running' ? 'running' : 'idle'))

      const rack = h('section', null,
        h('div', { className: 'sc-sect' },
          h('h2', null, '集群'),
          h('span', { className: 'count' },
            (clusterKnown ? liveAgents.length : '—') + ' 个活会话 · '
            + (clusterKnown ? liveRunning : '—') + ' 运行中 · shell 作业 '
            + (cluster?.jobs?.active ?? '—')),
          h('div', { className: 'sc-rule' })),
        h('div', { className: 'sc-card' },
          h('div', { className: 'sc-rack' },
            clusterCells.length ? clusterCells
              : h('div', { style: { color: 'var(--sc-dim)', fontSize: 12 } }, clusterKnown ? '没有活会话' : '会话数据未知')),
          h('div', { className: 'sc-legend' },
            h('span', { className: 'sc-lg run' }, h('i'), '运行中'),
            h('span', { className: 'sc-lg' }, h('i'), '空闲'),
            h('span', { className: 'sc-lg', style: { marginLeft: 'auto' } },
              '只含本 DSH 进程；superagent 执行器会话在它自己的进程里'))))

      const cols = h('section', { className: 'sc-cols' },
        h('div', { className: 'sc-card' },
          h('div', { className: 'sc-eyebrow' }, h('span', { className: 'sc-badge', style: { marginRight: 7 } }, primaryId), t.decisions),
          h('ul', { className: 'sc-decs' }, decItems)),
        h('div', { className: 'sc-card' },
          h('div', { className: 'sc-eyebrow' }, h('span', { className: 'sc-badge', style: { marginRight: 7 } }, primaryId), t.sources),
          sourceRows))

      const footer = h('footer', { className: 'sc-foot' },
        h('span', { className: 'sc-mono' }, 'master ' + String(state.masterId || '').slice(0, 20)),
        h('span', { className: 'sc-mono' }, 'policy ' + String(overview.policyVersion || '').slice(0, 12)),
        h('span', null, panelUrl + '/orchestrator/api'))

      /* --- 多实例（cockpit-fleet）：两个实例并排，每个自带槽位/KPI/工单 --- */
      const fleetSection = fleetList
        ? h('section', { className: 'sc-fleet' },
          fleetList.map(ins => h(InstanceCard, { key: ins.id, ins, t })),
          h('div', { className: 'sc-card', style: { gridColumn: '1 / -1' } },
            h('div', { className: 'sc-eyebrow' }, '各实例明细'),
            h('table', { className: 'sc-mono', style: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 } },
              h('thead', null, h('tr', null,
                ['实例', '仓库', '账号', '执行器', '打开工单', '问题', '健康'].map(x =>
                  h('th', { key: x, style: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,.12)', opacity: 0.7 } }, x)))),
              h('tbody', null, fleetList.map(ins => {
                const acc = (ins.state && ins.state.setup && ins.state.setup.accounts) || {}
                const ex = (ins.overview && ins.overview.executor) || {}
                const open = (ins.tickets && ins.tickets.items) || []
                const probs = (ins.overview && ins.overview.problems) || []
                const health = (ins.state && ins.state.health) || {}
                const healthTxt = Object.entries(health).map(([k, v]) => k + ':' + ((v && v.state) || '?')).join('  ')
                return h('tr', { key: 'r' + ins.id },
                  h('td', { style: { padding: '6px 8px' } }, (ins.id || '') + (ins.ok ? '' : ' (离线)')),
                  h('td', { style: { padding: '6px 8px' } }, acc.repository || '—'),
                  h('td', { style: { padding: '6px 8px' } }, acc.agent || '—'),
                  h('td', { style: { padding: '6px 8px' } }, (ex.running ?? '—') + '/' + (ex.maxWorkers ?? '—') + '  排队 ' + (ex.queued ?? '—')),
                  h('td', { style: { padding: '6px 8px' } }, ins.ok ? String(open.length) : '—'),
                  h('td', { style: { padding: '6px 8px' } }, ins.ok ? String(probs.length) : '—'),
                  h('td', { style: { padding: '6px 8px' } }, healthTxt || '—'))
              }))))
        )
        : null

      return h('div', { className: 'sc-page', style: vars },
        h('style', null, CSS), head,
        // D2-1：主控 · SUPER AGENTS 前置到第一屏，紧跟头部；对练台与它相邻。
        // 用户要在这页里立刻看到「正在跑的 Super Agent」，不能埋在三张实例卡和明细表下面。
        saSection,
        sparringSection,
        fleetSection,
        fleetSection || !primaryReady ? null : hero,
        fleetSection || !primaryReady ? null : kpis,
        primaryReady ? sect : h('div', { className: 'sc-alert' }, t.offline),
        primaryReady ? probs : null, primaryReady ? sessions : null, rack,
        primaryReady ? cols : null, primaryReady ? footer : null)
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => TEXTS[langOf(ctx)].label,
      }, Icon)), 'dsh-superagent-cockpit: sidebar entry')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: PANEL_ID,
      }, props => h(Page, Object.assign({}, props, { __ctx: ctx })))), 'dsh-superagent-cockpit: page')
    }

    return { inject, apply }
  },
})
