/* 无线话筒频点协调台 —— 原生 JS 前端 */
"use strict";

const state = {
  planId: null,
  // 展示中的结果：{ key, data }。key 为求解时刻的输入指纹，
  // 仅当 key 与当前输入指纹一致时结果才属于当前页面，否则一律撤下。
  result: null,
  // 求解请求序号：每次求解、每次编辑输入、每次方案切换（新建/打开/删除
  // 当前方案）都递增，响应回来时序号不匹配即为过期请求，静默丢弃。
  solveSeq: 0,
  planMenuOpen: false,
};

const $ = (sel) => document.querySelector(sel);

function toast(msg, isErr = false) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ""), 2600);
}

// --------------------------- 方案数据 ---------------------------

function defaultPlan() {
  return {
    name: "",
    minGap: 5,
    imTolerance: 0,
    timeLimit: 10,
    forbidden: [],
    mics: [blankMic("A"), blankMic("B")],
  };
}

function blankMic(id) {
  return { id, candidates: [], current: null, locked: false };
}

let plan = defaultPlan();

// --------------------------- 渲染：话筒卡片 ---------------------------

function renderMics() {
  const wrap = $("#mics");
  wrap.innerHTML = "";
  plan.mics.forEach((mic, idx) => {
    const card = document.createElement("div");
    card.className = "mic-card";
    card.innerHTML = `
      <div class="mic-head">
        <input class="id-input" data-k="id" value="${escapeHtml(mic.id)}"
               maxlength="10" title="设备 ID">
        <label class="lock-wrap">
          <input type="checkbox" data-k="locked" ${mic.locked ? "checked" : ""}>
          🔒 锁定
        </label>
        <span class="spacer"></span>
        <button class="btn btn-small btn-danger" data-act="del"
                ${plan.mics.length <= 2 ? "disabled" : ""}>删除</button>
      </div>
      <div class="mic-field">
        <div class="cap">候选频点（1～12 个互异正整数 kHz，用空格/逗号分隔）
          <span class="cand-count">${mic.candidates.length}/12</span>
        </div>
        <textarea class="cand-area" data-k="candidates" rows="2"
          placeholder="例如：520 530 540 550">${mic.candidates.join(", ")}</textarea>
      </div>
      <div class="mic-field">
        <div class="cap">现用频点（可选，须在候选中）</div>
        <div class="current-row">
          <select data-k="current">
            <option value="">— 无 —</option>
            ${[...mic.candidates]
              .sort((a, b) => a - b)
              .map(
                (f) =>
                  `<option value="${f}" ${mic.current === f ? "selected" : ""}>${f} kHz</option>`
              )
              .join("")}
          </select>
        </div>
      </div>`;

    card.querySelector('[data-k="id"]').addEventListener("input", (e) => {
      mic.id = e.target.value.trim();
      onPlanEdited();
    });

    card.querySelector('[data-k="locked"]').addEventListener("change", (e) => {
      mic.locked = e.target.checked;
      if (mic.locked && mic.current == null && mic.candidates.length) {
        // 锁定必须有现用频点：默认取最小候选
        mic.current = Math.min(...mic.candidates);
        renderMics();
      }
      onPlanEdited();
    });

    // 候选频点为“控件草稿”：每次键入都即时解析入 plan（不重绘，避免输入中
    // 丢焦点），保证指纹、求解与保存读到的永远是界面上的最新值；
    // 失焦（change）时再重绘，规范化下拉项、计数等派生展示。
    const candArea = card.querySelector('[data-k="candidates"]');
    const commitCandidates = (rebuild) => {
      const parsed = parseCandidates(candArea.value);
      mic.candidates = parsed.values;
      if (mic.current != null && !mic.candidates.includes(mic.current)) {
        mic.current = null;
        // 键入过程中不重绘，但要让现用频点下拉与 plan 保持一致，避免界面
        // 仍选中一个已不在候选中的旧值。
        card.querySelector('[data-k="current"]').value = "";
      }
      if (rebuild) renderMics();
      onPlanEdited();
    };
    candArea.addEventListener("input", () => commitCandidates(false));
    candArea.addEventListener("change", () => commitCandidates(true));

    card.querySelector('[data-k="current"]').addEventListener("change", (e) => {
      mic.current = e.target.value === "" ? null : parseInt(e.target.value, 10);
      onPlanEdited();
    });

    card.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (plan.mics.length <= 2) return;
      plan.mics.splice(idx, 1);
      renderMics();
      onPlanEdited();
    });

    wrap.appendChild(card);
  });
}

function parseCandidates(text) {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  const values = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
  }
  return { values, rawCount: parts.length };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// --------------------------- 渲染：禁用区间 ---------------------------

function renderBands() {
  const wrap = $("#bands");
  wrap.innerHTML = "";
  plan.forbidden.forEach((b, idx) => {
    const chip = document.createElement("span");
    chip.className = "band-chip";
    chip.innerHTML = `
      <input type="number" min="1" step="1" value="${b.low ?? ""}" title="下限（含）">
      <span>～</span>
      <input type="number" min="1" step="1" value="${b.high ?? ""}" title="上限（含）">
      <span>kHz</span>
      <button class="btn btn-small btn-danger" data-act="delband">×</button>`;
    const [lo, hi] = chip.querySelectorAll("input");
    // 禁用区间上下限同样键入即写入 plan：输入一发生指纹即变，
    // 旧结果立即撤下、在途求解随之失效；空值等非法草稿留待校验时报错，
    // 绝不静默使用重绘出的旧值。
    const commitBand = (field, input) => {
      const n = parseInt(input.value, 10);
      plan.forbidden[idx][field] = Number.isNaN(n) ? null : n;
      onPlanEdited();
    };
    lo.addEventListener("input", () => commitBand("low", lo));
    lo.addEventListener("change", () => commitBand("low", lo));
    hi.addEventListener("input", () => commitBand("high", hi));
    hi.addEventListener("change", () => commitBand("high", hi));
    chip.querySelector('[data-act="delband"]').addEventListener("click", () => {
      plan.forbidden.splice(idx, 1);
      renderBands();
      onPlanEdited();
    });
    wrap.appendChild(chip);
  });
}

// --------------------------- 参数读取与校验 ---------------------------

function collectPlan() {
  plan.name = $("#planName").value.trim();
  plan.minGap = parseInt($("#minGap").value, 10);
  plan.imTolerance = parseInt($("#imTolerance").value, 10);
  plan.timeLimit = parseInt($("#timeLimit").value, 10);
  return plan;
}

// --------------------------- 结果归属规则 ---------------------------
//
// 结果只属于“产生它的那份输入”：
//   * 求解时记录输入指纹 reqKey 与请求序号 reqId；
//   * 响应（无论成功/失败）回来时，reqId 仍是最新且当前输入指纹仍等于
//     reqKey，结果才允许上屏，否则静默丢弃；
//   * 任何输入变动（包括候选频点文本框、禁用区间上下限等键入中尚未失焦的
//     控件草稿，草稿在每次 input 事件即时入 plan）都会改变指纹：
//     onPlanEdited() 立即撤下失效结果、递增 solveSeq 作废旧求解并解锁按钮；
//   * 打开另一方案的 GET 发起时即递增 solveSeq 并撤下结果，读取失败保留
//     当前方案的编辑内容；过期的打开响应（成功/失败）既不回填也不报错；
//   * 新建/删除当前方案同样递增 solveSeq 并清空结果，在途旧请求全部过期。
// 指纹只含影响求解与展示的字段（方案名称不影响协调结果，不计入）。

function planFingerprint() {
  collectPlan();
  const norm = {
    minGap: plan.minGap,
    imTolerance: plan.imTolerance,
    timeLimit: plan.timeLimit,
    forbidden: plan.forbidden
      .map((b) => [b.low, b.high])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    mics: plan.mics.map((m) => [
      m.id,
      [...m.candidates].sort((a, b) => a - b),
      m.current,
      m.locked,
    ]),
  };
  return JSON.stringify(norm);
}

function invalidateResult() {
  state.result = null;
  $("#resultPanel").hidden = true;
  clearCanvas();
}

// 当前展示中的结果是否仍对应当前输入（窗口缩放等非编辑动作也可安全调用）。
function resultStillCurrent() {
  return !state.result || state.result.key === planFingerprint();
}

// 任何编辑动作后调用：
//   1. 展示中的结果若不再对应当前输入，立即从结果表与频谱撤下；
//   2. 递增求解序号，使任何在途求解（含迟到的成功/失败响应）立即失效；
//   3. 解除“求解中”按钮锁定，允许立刻以新输入重新求解。
function onPlanEdited() {
  if (!resultStillCurrent()) invalidateResult();
  state.solveSeq++;
  setSolveBusy(false);
}

function setSolveBusy(busy) {
  const btn = $("#btnSolve");
  btn.disabled = busy;
  btn.textContent = busy ? "求解中…" : "▶ 协调求解";
}

// 方案上下文切换（新建/删除当前方案；打开方案在请求发起时自行处理）：
// 作废旧求解请求、撤下旧结果、复位求解按钮。
function switchPlanContext() {
  state.solveSeq++;
  invalidateResult();
  setSolveBusy(false);
}

function validatePlan(p) {
  const errs = [];
  if (!p.name) errs.push("请填写方案名称");
  if (!Number.isInteger(p.minGap) || p.minGap < 1)
    errs.push("最小频差 d 须为正整数");
  if (!Number.isInteger(p.imTolerance) || p.imTolerance < 0)
    errs.push("互调容差 g 须为非负整数");
  if (!Number.isInteger(p.timeLimit) || p.timeLimit < 1)
    errs.push("求解时限须为正整数秒");

  for (const [i, b] of p.forbidden.entries()) {
    if (!Number.isInteger(b.low) || !Number.isInteger(b.high) || b.low < 1)
      errs.push(`禁用区间 #${i + 1} 频点须为正整数`);
    else if (b.low > b.high)
      errs.push(`禁用区间 #${i + 1} 下限（${b.low}）不能大于上限（${b.high}）`);
  }

  if (p.mics.length < 2 || p.mics.length > 8)
    errs.push("话筒数量须在 2～8 支之间");

  const ids = p.mics.map((m) => m.id);
  if (ids.some((id) => !id)) errs.push("每支话筒都必须填写设备 ID");
  if (new Set(ids).size !== ids.length) errs.push("设备 ID 不得重复");

  for (const m of p.mics) {
    if (m.candidates.length < 1 || m.candidates.length > 12)
      errs.push(`设备 ${m.id || "?"} 候选频点须为 1～12 个互异正整数 kHz`);
    if (m.current != null && !m.candidates.includes(m.current))
      errs.push(`设备 ${m.id} 的现用频点 ${m.current} kHz 不在候选频点中`);
    if (m.locked && m.current == null)
      errs.push(`锁定设备 ${m.id} 必须填写现用频点`);
  }
  return errs;
}

// --------------------------- 求解 ---------------------------

async function solvePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }
  const reqId = ++state.solveSeq;
  const reqKey = planFingerprint();
  const payload = toApiPayload(plan);
  // 归属判定：仍是最后一次求解、且输入自提交起未变，响应才属于当前页面
  const isCurrent = () =>
    reqId === state.solveSeq && reqKey === planFingerprint();
  setSolveBusy(true);
  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!isCurrent()) return; // 过期成功响应：不得重现结果
    state.result = { key: reqKey, data };
    renderResult(data);
  } catch (e) {
    if (!isCurrent()) return; // 过期失败响应：不得报错
    toast("求解失败：" + e.message, true);
  } finally {
    // 仅在仍是当前请求时复位按钮；过期请求的收尾不得干扰新上下文
    if (reqId === state.solveSeq) setSolveBusy(false);
  }
}

function toApiPayload(p) {
  return {
    name: p.name,
    minGap: p.minGap,
    imTolerance: p.imTolerance,
    timeLimit: p.timeLimit,
    forbidden: p.forbidden.map((b) => ({ low: b.low, high: b.high })),
    mics: p.mics.map((m) => ({
      id: m.id,
      candidates: [...m.candidates].sort((a, b) => a - b),
      current: m.current,
      locked: m.locked,
    })),
  };
}

// --------------------------- 结果渲染 ---------------------------

function renderResult(r) {
  const panel = $("#resultPanel");
  panel.hidden = false;

  const banner = $("#statusBanner");
  const conflictBox = $("#conflicts");
  const summary = $("#resultSummary");
  conflictBox.innerHTML = "";
  summary.innerHTML = "";

  if (r.status === "conflict") {
    banner.className = "banner conflict";
    banner.innerHTML =
      '<span class="big">⛔ 锁定集合冲突</span>' +
      "锁定设备必须保留现用频点，下列规则无法同时满足，未进行分配求解。";
    conflictBox.innerHTML = r.conflicts
      .map(
        (c) => `
      <div class="conflict-item">
        <span class="tag">${escapeHtml(c.rule)}</span>
        <span class="devs">[${c.devices.map(escapeHtml).join(", ")}]</span>
        <div>${escapeHtml(c.detail)}</div>
      </div>`
      )
      .join("");
    $("#resultTable").innerHTML = "";
    $("#phaseLog").textContent = "";
    clearCanvas();
    panel.scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (r.optimal) {
    banner.className = "banner optimal";
    banner.innerHTML =
      '<span class="big">✅ 已证最优</span>' +
      `在 ${r.solveTimeMs} ms 内证明该方案满足全部优先级最优。`;
  } else {
    banner.className = "banner feasible";
    banner.innerHTML =
      '<span class="big">⚠️ 可行解（未证最优）</span>' +
      `已在求解时限（${r.timeLimitSec} 秒）内找到可行解，但未能证明其最优性；` +
      `可尝试延长求解时限。实际用时 ${r.solveTimeMs} ms。`;
  }

  summary.innerHTML = `
    <span>已分配 <b>${r.assignedCount}</b> / ${r.assignment.length} 支</span>
    <span>现用频点变更 <b>${r.changeCount}</b> 台</span>
    <span>最小频差 d = <b>${plan.minGap}</b> kHz</span>
    <span>互调容差 g = <b>${plan.imTolerance}</b> kHz</span>`;

  // 表格
  const rows = r.assignment
    .map(
      (a) => `
    <tr class="${a.assigned ? "assigned" : "unassigned"}">
      <td>${escapeHtml(a.id)} ${a.locked ? '<span class="locked-mark">🔒</span>' : ""}</td>
      <td>${a.current == null ? "—" : a.current + " kHz"}</td>
      <td class="freq-cell">${a.assigned ? a.frequency + " kHz" : "<i>未分配</i>"}</td>
      <td>${a.changed ? '<span class="changed-mark">✔ 变更</span>' : "—"}</td>
      <td>${a.assigned ? "✔" : "—"}</td>
    </tr>`
    )
    .join("");
  $("#resultTable").innerHTML = `
    <table>
      <thead><tr>
        <th>设备 ID</th><th>现用频点</th><th>协调频点</th><th>是否变更</th><th>已分配</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $("#phaseLog").textContent = r.phases
    .map((p) => `[阶段${p.order}] ${p.phase}  →  ${p.status}${p.objective != null ? "  (目标值 " + p.objective + ")" : ""}`)
    .join("\n");

  drawSpectrum(plan, r);
  panel.scrollIntoView({ behavior: "smooth" });
}

// --------------------------- 频谱绘制 ---------------------------

function clearCanvas() {
  const cv = $("#spectrum");
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

function drawSpectrum(p, r) {
  const cv = $("#spectrum");
  const ctx = cv.getContext("2d");

  // 高分屏适配
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 1100;
  const rowH = 34;
  const cssH = Math.max(200, 90 + r.assignment.length * rowH + 40);
  cv.style.height = cssH + "px";
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const padL = 80, padR = 30, padT = 34, padB = 34;

  const allFreqs = p.mics.flatMap((m) => m.candidates);
  let fMin = Math.min(...allFreqs);
  let fMax = Math.max(...allFreqs);
  const span = Math.max(1, fMax - fMin);
  fMin -= span * 0.05 + 2;
  fMax += span * 0.05 + 2;

  const xOf = (f) => padL + ((f - fMin) / (fMax - fMin)) * (W - padL - padR);
  const plotW = W - padL - padR;

  ctx.clearRect(0, 0, W, cssH);

  // 禁用闭区间
  for (const b of p.forbidden) {
    const x1 = xOf(Math.max(b.low, fMin));
    const x2 = xOf(Math.min(b.high, fMax));
    if (x2 < padL || x1 > W - padR) continue;
    ctx.fillStyle = "rgba(255,90,90,0.16)";
    ctx.fillRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.strokeStyle = "rgba(255,90,90,0.55)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,120,120,0.9)";
    ctx.font = "10px sans-serif";
    ctx.fillText(`禁用 ${b.low}~${b.high}`, x1 + 4, padT + 4);
  }

  // 坐标轴与网格
  const gridStep = niceStep((fMax - fMin) / 8);
  ctx.strokeStyle = "rgba(147,161,184,0.18)";
  ctx.fillStyle = "#93a1b8";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  const startTick = Math.ceil(fMin / gridStep) * gridStep;
  for (let f = startTick; f <= fMax; f += gridStep) {
    const x = xOf(f);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, cssH - padB);
    ctx.stroke();
    ctx.fillText(f + "", x, cssH - padB + 16);
  }
  ctx.textAlign = "left";
  ctx.fillText("频率 / kHz", padL, cssH - 6);

  // 图例
  const legend = [
    ["#7d8ca3", "候选"],
    ["#4f9cff", "现用"],
    ["#34c79a", "已分配"],
    ["#b48cff", "锁定"],
  ];
  let lx = W - padR - 220;
  legend.forEach(([color, name]) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, 16, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c6d2e4";
    ctx.font = "11px sans-serif";
    ctx.fillText(name, lx + 9, 20);
    lx += 58;
  });

  // 每支话筒一行
  const byId = Object.fromEntries(r.assignment.map((a) => [a.id, a]));
  p.mics.forEach((mic, i) => {
    const y = padT + 14 + i * rowH;
    const a = byId[mic.id];

    ctx.strokeStyle = "rgba(147,161,184,0.25)";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();

    ctx.fillStyle = "#c6d2e4";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(mic.id + (mic.locked ? " 🔒" : ""), padL - 8, y + 4);
    ctx.textAlign = "center";

    // 候选刻度
    ctx.strokeStyle = "#7d8ca3";
    ctx.lineWidth = 1.5;
    for (const f of mic.candidates) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y + 6);
      ctx.stroke();
    }

    // 现用：蓝色空心三角
    if (mic.current != null) {
      const x = xOf(mic.current);
      ctx.strokeStyle = "#4f9cff";
      ctx.fillStyle = "rgba(79,156,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x - 6, y + 4);
      ctx.lineTo(x + 6, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 已分配：大圆点 + 频点标注
    if (a && a.assigned) {
      const x = xOf(a.frequency);
      ctx.fillStyle = a.locked ? "#b48cff" : "#34c79a";
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d1524";
      ctx.font = "bold 9px sans-serif";
      ctx.fillText(a.locked ? "L" : "✓", x, y + 3);
      ctx.fillStyle = a.locked ? "#d8c4ff" : "#8ff0d2";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(a.frequency + "", x, y - 12);
    } else {
      ctx.fillStyle = "#8a7a55";
      ctx.font = "11px sans-serif";
      ctx.fillText("未分配", W - padR - 30, y + 4);
    }
  });
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  let f;
  if (n < 1.5) f = 1;
  else if (n < 3.5) f = 2;
  else if (n < 7.5) f = 5;
  else f = 10;
  return f * pow;
}

// --------------------------- 保存 / 打开 ---------------------------

async function savePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }
  const payload = toApiPayload(plan);
  try {
    let resp;
    if (state.planId) {
      resp = await fetch(`/api/plans/${state.planId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.detail || `HTTP ${resp.status}`);
    }
    const saved = await resp.json();
    state.planId = saved.id;
    $("#planName").value = saved.name;
    toast(`方案「${saved.name}」已保存（#${saved.id}）`);
  } catch (e) {
    toast("保存失败：" + e.message, true);
  }
}

async function renderPlanMenu() {
  const menu = $("#planMenu");
  try {
    const resp = await fetch("/api/plans");
    const plans = await resp.json();
    menu.innerHTML = "";
    if (!plans.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "（暂无已保存方案）";
      menu.appendChild(li);
    } else {
      for (const p of plans) {
        const li = document.createElement("li");
        li.innerHTML = `
          <span class="pname">${escapeHtml(p.name)}
            <div class="pmeta">#${p.id}　更新于 ${escapeHtml(p.updatedAt)}</div>
          </span>
          <button class="del" title="删除">🗑</button>`;
        li.querySelector(".pname").addEventListener("click", () => loadPlan(p.id));
        li.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          deletePlan(p.id);
        });
        menu.appendChild(li);
      }
    }
  } catch (e) {
    toast("读取方案列表失败：" + e.message, true);
  }
}

async function togglePlanMenu() {
  const menu = $("#planMenu");
  if (state.planMenuOpen) {
    menu.hidden = true;
    state.planMenuOpen = false;
    return;
  }
  await renderPlanMenu();
  menu.hidden = false;
  state.planMenuOpen = true;
}

async function loadPlan(id) {
  // 请求一发出即切换上下文：递增求解序号使任何在途旧求解立即失效，
  // 撤下旧结果并复位求解按钮。此时还未改动 plan —— 若读取失败，
  // 用户正在编辑的原方案内容原样保留。
  const reqId = ++state.solveSeq;
  invalidateResult();
  setSolveBusy(false);
  let resp;
  try {
    resp = await fetch(`/api/plans/${id}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rec = await resp.json();
    // 等待期间又发起了更新的打开/新建：本响应已过期，不回填、不报错
    if (reqId !== state.solveSeq) return;
    const d = rec.plan;
    plan = {
      name: d.name,
      minGap: d.minGap,
      imTolerance: d.imTolerance,
      timeLimit: d.timeLimit,
      forbidden: d.forbidden.map((b) => ({ ...b })),
      mics: d.mics.map((m) => ({
        id: m.id,
        candidates: [...m.candidates],
        current: m.current,
        locked: m.locked,
      })),
    };
    state.planId = rec.id;
    syncFormFromPlan();
    $("#planMenu").hidden = true;
    state.planMenuOpen = false;
    toast(`已打开方案「${rec.name}」`);
  } catch (e) {
    // 过期失败响应静默丢弃；只有仍属当前打开请求的失败才提示，
    // 且不动 plan / planId，编辑器里的原方案内容保留可继续编辑。
    if (reqId !== state.solveSeq) return;
    toast("打开失败：" + e.message, true);
  }
}

async function deletePlan(id) {
  if (!confirm(`确认删除方案 #${id}？`)) return;
  const resp = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  if (!resp.ok) {
    toast("删除失败", true);
    return;
  }
  if (state.planId === id) newPlan(false);
  await renderPlanMenu();
  toast("方案已删除");
}

function syncFormFromPlan() {
  $("#planName").value = plan.name;
  $("#minGap").value = plan.minGap;
  $("#imTolerance").value = plan.imTolerance;
  $("#timeLimit").value = plan.timeLimit;
  renderBands();
  renderMics();
}

function newPlan(confirmFlag = true) {
  if (confirmFlag && !confirm("新建将清空当前未保存的编辑，确定？")) return;
  plan = defaultPlan();
  state.planId = null;
  switchPlanContext();
  syncFormFromPlan();
}

// --------------------------- 初始化 ---------------------------

function init() {
  renderBands();
  renderMics();

  $("#minGap").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#imTolerance").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#timeLimit").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#btnAddBand").addEventListener("click", () => {
    collectPlan();
    const base = plan.forbidden.length
      ? plan.forbidden[plan.forbidden.length - 1].high + 1
      : 500;
    plan.forbidden.push({ low: base, high: base + 10 });
    renderBands();
    onPlanEdited();
  });
  $("#btnAddMic").addEventListener("click", () => {
    collectPlan();
    if (plan.mics.length >= 8) {
      toast("最多支持 8 支话筒", true);
      return;
    }
    const used = new Set(plan.mics.map((m) => m.id));
    let id = "A";
    for (let i = 0; used.has(id); i++) {
      id = String.fromCharCode(65 + ((i + 1) % 26)) + (i >= 25 ? i + 1 : "");
    }
    plan.mics.push(blankMic(id));
    renderMics();
    onPlanEdited();
  });
  $("#btnSolve").addEventListener("click", solvePlan);
  $("#btnSave").addEventListener("click", savePlan);
  $("#btnOpen").addEventListener("click", togglePlanMenu);
  $("#btnNew").addEventListener("click", () => newPlan(true));
  document.addEventListener("click", (e) => {
    if (state.planMenuOpen &&
        !$("#planMenu").contains(e.target) &&
        e.target !== $("#btnOpen")) {
      $("#planMenu").hidden = true;
      state.planMenuOpen = false;
    }
  });
  window.addEventListener("resize", () => {
    // 缩放只重绘仍属于当前输入的结果；指纹不匹配时先撤下，避免新旧混绘。
    // 注意：缩放不是编辑动作，不递增 solveSeq、不影响在途求解。
    if (!resultStillCurrent()) invalidateResult();
    if (state.result) drawSpectrum(plan, state.result.data);
  });
}

init();
