/* 结果归属规则的前端逻辑测试（Node 运行，DOM 以桩代替）。
 *
 * 运行：node tests/result_ownership.test.js
 *
 * 覆盖场景：
 *   1. 求解成功且输入未变   -> 结果上屏；
 *   2. 求解后编辑输入       -> 旧结果立即撤下；
 *   3. 求解期间编辑输入     -> 过期成功响应被丢弃，按钮正常复位；
 *   4. 求解期间新建方案     -> 旧成功响应不回填；
 *   5. 求解期间打开另一方案 -> 旧失败响应不报错；
 *   6. 未改输入的保存       -> 不误删有效结果；
 *   7. 冲突结果             -> 如实上屏；
 *   8. 窗口缩放             -> 仅重绘仍属于当前输入的结果；
 *   9. 候选频点文本框键入（未失焦）-> 草稿即时入 plan，旧结果即撤、
 *      在途求解失效，保存/求解使用界面新值；
 *  10. 禁用区间上下限键入（未失焦）-> 同上，非法草稿不静默求解/保存；
 *  11. 打开请求发起即作废旧求解（旧失败不报错，成功后新方案上屏）；
 *  12. 打开失败保留原编辑；过期的打开成功/失败均静默。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- DOM 桩 ---------------------------

const elements = {};
const winListeners = {};

function makeCtx() {
  // 画布 2D 上下文：任何方法调用都是空操作，属性可写
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set: (target, prop, v) => {
        target[prop] = v;
        return true;
      },
    }
  );
}

function makeEl(id) {
  const el = {
    id,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    value: "",
    className: "",
    style: {},
    clientWidth: 1100,
    width: 1100,
    height: 320,
    _listeners: {},
    _children: [],
    _html: "",
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    // querySelector / querySelectorAll 需记忆化：渲染时绑定监听的节点与
    // 驱动里派发事件取出的节点必须是同一个。
    querySelector(sel) {
      this._qs = this._qs || {};
      return this._qs[sel] || (this._qs[sel] = makeEl(this.id + " " + sel));
    },
    querySelectorAll(sel) {
      this._qsa = this._qsa || {};
      if (!this._qsa[sel]) {
        this._qsa[sel] = [makeEl(this.id + "/q1"), makeEl(this.id + "/q2")];
      }
      return this._qsa[sel];
    },
    appendChild(child) {
      this._children.push(child);
      return child;
    },
    scrollIntoView() {},
    getContext() {
      return makeCtx();
    },
  };
  // innerHTML 赋值（渲染时清空容器）连带清掉已追加子节点
  Object.defineProperty(el, "innerHTML", {
    get() {
      return this._html;
    },
    set(v) {
      this._html = v;
      this._children.length = 0;
    },
  });
  return el;
}

global.document = {
  querySelector(sel) {
    if (!elements[sel]) elements[sel] = makeEl(sel);
    return elements[sel];
  },
  createElement: (tag) => makeEl("<" + tag + ">"),
  addEventListener() {},
  body: { appendChild() {} },
};
global.window = {
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    (winListeners[type] = winListeners[type] || []).push(fn);
  },
};
global.confirm = () => true;

// 可控 fetch：被测代码内 fetch(...) 解析到全局，驱动用 __fetchImpl 换实现
globalThis.__fetchImpl = () => Promise.reject(new Error("fetch 未 mock"));
global.fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
};
globalThis.__fire = (el, type, value) => {
  if (value !== undefined) el.value = value;
  const ev = { target: el };
  (el._listeners[type] || []).forEach((fn) => fn(ev));
};
globalThis.__fireResize = () =>
  (winListeners.resize || []).forEach((f) => f());

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

// 驱动代码与被测代码同一 eval 作用域，可直接访问其顶层绑定
// （state / plan / solvePlan / savePlan / loadPlan / newPlan /
//   onPlanEdited / drawSpectrum ...）
const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const VALID_MICS = [
    { id: "A", candidates: [520, 540], current: null, locked: false },
    { id: "B", candidates: [525, 545], current: null, locked: false },
  ];
  const SOLVE_OK = {
    status: "optimal", optimal: true, assignedCount: 2, changeCount: 0,
    solveTimeMs: 5, timeLimitSec: 10, phases: [],
    assignment: [
      { id: "A", locked: false, current: null, assigned: true, frequency: 520, changed: false },
      { id: "B", locked: false, current: null, assigned: true, frequency: 545, changed: false },
    ],
    conflicts: [],
  };
  const setValidPlan = () => {
    $el("#planName").value = "测试方案";
    $el("#minGap").value = "5";
    $el("#imTolerance").value = "0";
    $el("#timeLimit").value = "10";
    plan.mics = VALID_MICS.map((m) => ({ ...m, candidates: [...m.candidates] }));
  };

  // 1. 求解成功且输入未变 -> 上屏
  setValidPlan();
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("求解成功且输入未变：结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 2. 求解后编辑输入 -> 立即撤下
  plan.mics[0].id = "A2";
  onPlanEdited();
  t("求解后改设备 ID：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);
  plan.mics[0].id = "A";

  // 3. 求解期间编辑输入 -> 过期成功响应被丢弃，按钮复位
  const d1 = __deferred();
  globalThis.__fetchImpl = () => d1.p;
  const p1 = solvePlan();
  plan.mics[0].candidates = [521, 541];
  onPlanEdited();
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("求解期间改候选频点：过期成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);
  t("求解期间编辑：求解按钮正常复位",
    $el("#btnSolve").disabled === false);

  // 4. 求解期间新建方案 -> 旧成功响应不回填
  plan.mics[0].candidates = [520, 540];
  const d2 = __deferred();
  globalThis.__fetchImpl = () => d2.p;
  const p2 = solvePlan();
  newPlan(false);
  d2.resolve({ ok: true, json: async () => SOLVE_OK });
  await p2;
  t("求解期间新建方案：旧成功响应不回填",
    state.result === null && $el("#resultPanel").hidden === true);
  t("新建方案后：求解按钮可用", $el("#btnSolve").disabled === false);

  // 5. 求解期间打开另一方案 -> 旧失败响应不报错
  setValidPlan();
  const d3 = __deferred();
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/solve") return d3.p;
    if (url === "/api/plans/9") {
      return okJson({
        id: 9, name: "别方案",
        plan: {
          name: "别方案", minGap: 5, imTolerance: 0, timeLimit: 10,
          forbidden: [],
          mics: [
            { id: "C", candidates: [600, 610], current: null, locked: false },
            { id: "D", candidates: [620, 630], current: null, locked: false },
          ],
        },
      });
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const p3 = solvePlan();
  await loadPlan(9);
  d3.reject(new Error("网络错误"));
  await p3;
  t("求解期间打开另一方案：旧失败响应不报错",
    !$el("#toast").textContent.includes("求解失败"));
  t("打开另一方案后：无结果残留",
    state.result === null && $el("#resultPanel").hidden === true);

  // 6. 未改输入的保存 -> 不误删有效结果
  const SOLVE_OK_2 = {
    ...SOLVE_OK,
    assignment: [
      { id: "C", locked: false, current: null, assigned: true, frequency: 600, changed: false },
      { id: "D", locked: false, current: null, assigned: true, frequency: 620, changed: false },
    ],
  };
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/solve") return okJson(SOLVE_OK_2);
    if (url.startsWith("/api/plans")) return okJson({ id: 9, name: "别方案" });
    return Promise.reject(new Error("unexpected " + url));
  };
  await solvePlan();
  t("重新求解：结果上屏", state.result !== null);
  await savePlan();
  t("未改输入的保存：不误删有效结果",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 7. 冲突结果如实上屏
  const CONFLICT = {
    status: "conflict",
    conflicts: [{ devices: ["C"], rule: "禁用频点", detail: "锁定设备 C 落入禁用区间" }],
  };
  globalThis.__fetchImpl = () => okJson(CONFLICT);
  await solvePlan();
  t("冲突结果如实上屏",
    state.result !== null && state.result.data.status === "conflict" &&
    $el("#resultPanel").hidden === false);

  // 8. 窗口缩放：仅重绘仍属于当前输入的结果
  let drew = 0;
  drawSpectrum = () => { drew++; };
  __fireResize();
  t("结果有效时缩放：重绘频谱", drew === 1);
  plan.mics[0].id = "C9";
  onPlanEdited();
  __fireResize();
  t("输入失效后缩放：撤下且不再混绘",
    drew === 1 && state.result === null && $el("#resultPanel").hidden === true);

  // ---------- 9. 候选频点文本框：未失焦的键入草稿 ----------
  {
    newPlan(false);
    setValidPlan();
    renderMics(); // 按 plan 重建卡片并绑定监听（state 随之取到最新节点）
    const card0 = $el("#mics")._children[0];
    const candArea = card0.querySelector('[data-k="candidates"]');
    const mics0 = () => plan.mics[0].candidates;

    globalThis.__fetchImpl = () => okJson(SOLVE_OK);
    await solvePlan();
    t("场景9 准备：已取得有效结果", state.result !== null);

    // 9a. 键入新频点但不派发 change（未失焦）：plan 立即更新、指纹变、结果撤下
    __fire(candArea, "input", "520 540 555");
    t("候选频点键入未失焦：新值已写入 plan",
      mics0().length === 3 && mics0()[2] === 555);
    t("候选频点键入未失焦：旧结果立即撤下",
      state.result === null && $el("#resultPanel").hidden === true);

    // 9b. 键入发生在在途求解期间：旧求解作废，迟到成功不回填，按钮解锁
    const d9 = __deferred();
    globalThis.__fetchImpl = () => d9.p;
    const p9 = solvePlan();
    t("场景9 再次求解：按钮锁定", $el("#btnSolve").disabled === true);
    __fire(candArea, "input", "520 540 556");
    t("键入使在途求解失效：结果不残留、按钮解锁",
      state.result === null && $el("#btnSolve").disabled === false);
    d9.resolve({ ok: true, json: async () => SOLVE_OK });
    await p9;
    t("在途求解的迟到成功响应：不回填", state.result === null);

    // 9c. 失焦前点击保存：保存载荷必须使用界面草稿，而不是失焦前的旧值
    let savedBody = null;
    globalThis.__fetchImpl = (url, opts) => {
      if (url === "/api/plans") {
        savedBody = JSON.parse(opts.body);
        return okJson({ id: 77, name: savedBody.name });
      }
      return Promise.reject(new Error("unexpected " + url));
    };
    await savePlan();
    t("失焦前保存：使用界面草稿的候选新值",
      savedBody && JSON.stringify(savedBody.mics[0].candidates) ===
        JSON.stringify([520, 540, 556]));
  }

  // ---------- 10. 禁用区间上下限：未失焦的键入草稿 ----------
  {
    newPlan(false);
    setValidPlan();
    renderBands();
    // 直接按真实添加流程加入一个区间并渲染
    plan.forbidden.push({ low: 500, high: 510 });
    renderBands();
    const chip0 = $el("#bands")._children[0];
    const [lo, hi] = [chip0._qsa["input"][0], chip0._qsa["input"][1]];

    globalThis.__fetchImpl = () => okJson(SOLVE_OK);
    await solvePlan();
    t("场景10 准备：已取得有效结果", state.result !== null);

    // 10a. 修改下限但未失焦：plan 立即更新、结果撤下
    __fire(lo, "input", "480");
    t("禁用下限键入未失焦：新值已写入 plan", plan.forbidden[0].low === 480);
    t("禁用下限键入未失焦：旧结果立即撤下", state.result === null);

    // 10b. 保存使用草稿值
    let savedBody = null;
    globalThis.__fetchImpl = (url, opts) => {
      if (url.startsWith("/api/plans")) {
        savedBody = JSON.parse(opts.body);
        return okJson({ id: 78, name: savedBody.name });
      }
      return Promise.reject(new Error("unexpected " + url));
    };
    await savePlan();
    t("失焦前保存：使用界面草稿的禁用下限",
      savedBody && savedBody.forbidden[0].low === 480 &&
        savedBody.forbidden[0].high === 510);

    // 10c. 清空为非法草稿（NaN -> null）：不发起请求，直接校验报错
    __fire(hi, "input", "");
    let fetchCalled = false;
    globalThis.__fetchImpl = () => {
      fetchCalled = true;
      return Promise.reject(new Error("不应发起请求"));
    };
    await solvePlan();
    t("非法禁用区间草稿：不静默使用旧值求解，且不发请求",
      !fetchCalled && $el("#toast").textContent.includes("禁用区间"));
    await savePlan();
    t("非法禁用区间草稿：保存同样被拦截", !fetchCalled);
    // 恢复合法值，供后续场景使用
    __fire(hi, "input", "510");
    __fire(lo, "input", "500");
  }

  // ---------- 11. 打开请求发起即作废旧求解 ----------
  {
    newPlan(false);
    setValidPlan();
    renderMics();
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/solve") return okJson(SOLVE_OK);
      return Promise.reject(new Error("unexpected " + url));
    };
    await solvePlan();

    const dOpen = __deferred();
    const dSolve = __deferred();
    let solveOwner = null; // 当前在途的求解 promise（必须被消费）
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/plans/9") return dOpen.p;
      if (url === "/api/solve") return dSolve.p;
      return Promise.reject(new Error("unexpected " + url));
    };
    solveOwner = solvePlan(); // 真正发起一次在途求解
    const pOpen = loadPlan(9);
    // GET 已发出但尚未返回：旧求解序号已作废旧结果，且不等 GET 返回
    t("打开请求发起：旧结果立即撤下", state.result === null);
    t("打开请求发起：求解按钮可用", $el("#btnSolve").disabled === false);

    // 迟到的旧求解失败响应：不得报错
    dSolve.reject(new Error("网络错误"));
    await solveOwner;
    t("打开等待期旧求解失败：不报错",
      !$el("#toast").textContent.includes("求解失败"));

    dOpen.resolve({
      ok: true,
      json: async () => ({
        id: 9, name: "别方案",
        plan: {
          name: "别方案", minGap: 5, imTolerance: 0, timeLimit: 10,
          forbidden: [],
          mics: [
            { id: "C", candidates: [600, 610], current: null, locked: false },
            { id: "D", candidates: [620, 630], current: null, locked: false },
          ],
        },
      }),
    });
    await pOpen;
    t("打开成功：切换到新方案内容",
      state.planId === 9 && plan.mics[0].id === "C" &&
        $el("#planName").value === "别方案");
  }

  // ---------- 12. 打开失败保留原编辑；过期打开响应静默 ----------
  {
    // 12a. 打开不存在的方案：原编辑内容保留、planId 不变、仅提示一次
    const beforeName = $el("#planName").value;
    globalThis.__fetchImpl = () =>
      Promise.resolve({ ok: false, status: 404,
        json: async () => ({ detail: "方案不存在" }) });
    await loadPlan(404);
    t("打开失败：保留原方案编辑内容",
      state.planId === 9 && $el("#planName").value === beforeName &&
        plan.mics[0].id === "C");
    t("打开失败：当前打开请求的失败给出提示",
      $el("#toast").textContent.includes("打开失败"));

    // 12b. 过期的打开成功响应不回填
    const dStale = __deferred();
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/plans/10") return dStale.p;
      return Promise.reject(new Error("unexpected " + url));
    };
    const pStale = loadPlan(10); // 发起 #10 的打开（尚未返回）
    // 等待期改打开 #9（成功），#10 随即过期
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/plans/9") {
        return okJson({
          id: 9, name: "别方案",
          plan: {
            name: "别方案", minGap: 5, imTolerance: 0, timeLimit: 10,
            forbidden: [],
            mics: [
              { id: "C", candidates: [600, 610], current: null, locked: false },
              { id: "D", candidates: [620, 630], current: null, locked: false },
            ],
          },
        });
      }
      return Promise.reject(new Error("unexpected " + url));
    };
    await loadPlan(9);
    dStale.resolve({
      ok: true,
      json: async () => ({
        id: 10, name: "过期方案",
        plan: {
          name: "过期方案", minGap: 1, imTolerance: 0, timeLimit: 1,
          forbidden: [],
          mics: [
            { id: "X", candidates: [1, 2], current: null, locked: false },
            { id: "Y", candidates: [3, 4], current: null, locked: false },
          ],
        },
      }),
    });
    await pStale;
    t("过期打开成功响应：不回填，仍停留在新打开的方案",
      state.planId === 9 && plan.mics[0].id === "C" &&
        $el("#planName").value === "别方案");

    // 12c. 过期的打开失败响应不报错
    const dStale2 = __deferred();
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/plans/11") return dStale2.p;
      return Promise.reject(new Error("unexpected " + url));
    };
    const pStale2 = loadPlan(11);
    globalThis.__fetchImpl = (url) => {
      if (url === "/api/plans/9") {
        return okJson({
          id: 9, name: "别方案",
          plan: {
            name: "别方案", minGap: 5, imTolerance: 0, timeLimit: 10,
            forbidden: [],
            mics: [
              { id: "C", candidates: [600, 610], current: null, locked: false },
              { id: "D", candidates: [620, 630], current: null, locked: false },
            ],
          },
        });
      }
      return Promise.reject(new Error("unexpected " + url));
    };
    await loadPlan(9);
    $el("#toast").textContent = ""; // 清掉“已打开方案”的正常提示
    dStale2.resolve({
      ok: false, status: 500, json: async () => ({ detail: "服务器错误" }),
    });
    await pStale2;
    t("过期打开失败响应：静默，不报错",
      $el("#toast").textContent === "" && state.planId === 9);
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log("\\n" + (results.length - failed) + "/" + results.length + " 通过");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("驱动异常：", e);
  process.exit(1);
});
`;

try {
  // eslint-disable-next-line no-eval
  eval(src + "\n" + driver);
} catch (e) {
  console.error("加载被测代码失败：", e);
  process.exit(1);
}
