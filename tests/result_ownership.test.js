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
 *   8. 窗口缩放             -> 仅重绘仍属于当前输入的结果。
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
  return {
    id,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    className: "",
    style: {},
    clientWidth: 1100,
    width: 1100,
    height: 320,
    addEventListener() {},
    querySelector(sel) {
      return makeEl(id + " " + sel);
    },
    querySelectorAll() {
      return [makeEl(id + "/q1"), makeEl(id + "/q2")];
    },
    appendChild() {},
    scrollIntoView() {},
    getContext() {
      return makeCtx();
    },
  };
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
