# 无线话筒频点协调台

基于 **Python + FastAPI + SQLite + OR-Tools CP-SAT** 的约束求解后端，与**原生
JavaScript** 单页前端，用于在演出前为 2～8 支无线话筒协调互不干扰的工作频点。

## 功能

- 建立演出方案：录入 2～8 支话筒，每支 1～12 个**互异正整数 kHz** 候选频点、
  可选现用频点及 🔒 锁定标志；
- 全局设置：禁用闭区间 `[low, high]`（含端点）、正整数最小频差 **d**、
  非负整数互调容差 **g**、正整数秒求解时限；
- 录入校验：现用频点必须在候选频点中，锁定设备必须填写现用频点；
- 协调规则：
  - 🔒 锁定设备必须保留现用频点；
  - 任意两支**已分配**设备频差至少为 d：`|f_i - f_j| ≥ d`；
  - 任意互异三支设备 i、j、k：`|2·f_i − f_j − f_k| > g`（三阶互调回避，
    三支均已分配时生效）；
  - 禁用闭区间内的频点不得使用；
- 锁定集合存在冲突时，直接列出冲突设备及违反的规则（禁用频点 / 最小频差 /
  互调容差），不进行分配；
- 否则允许部分设备未分配，按优先级依次优化：
  1. **最大化已分配台数**；
  2. **最小化已分配设备的现用频点变更台数**；
  3. 按设备 ID 升序对频点序列取字典序最小（未分配视为大于所有候选频点的值
     `Fmax+1`，故未分配尽量排在序列末尾）；
- 界面展示频谱图（候选刻度、现用三角、已分配圆点、锁定高亮、禁用区间阴影）
  与结果表；
- 方案可保存到 SQLite 并随时重新打开、覆盖更新或删除；
- 求解时限耗尽仍未证明最优时，展示当前**可行解**与“未证最优”状态；
  已证最优时显示“已证最优”。
- **结果归属规则**：协调结果只展示属于“当前方案、当前输入”的那一次求解——
  - 求解期间新建/打开另一方案，或修改设备 ID、候选频点、现用频点、锁定、
    禁用区间或全局参数，旧结果立即从结果表与频谱撤下；
  - 过期的求解响应（无论成功或失败）不会回填结果，也不会弹出错误；
  - 输入未变动时保存方案，不影响正在展示的有效结果。

## 一、Docker Compose 一键启动（推荐）

```bash
docker compose up --build -d
```

访问地址：

- 应用界面：<http://localhost:8000/>
- API 文档（Swagger）：<http://localhost:8000/docs>

停止：

```bash
docker compose down
```

方案数据持久化在宿主机 `./data/plans.db`（SQLite）。
如本机 8000 端口被占用，可修改 `docker-compose.yml` 中端口映射，如
`"8080:8000"` 后访问 <http://localhost:8080/>。

## 二、本地直接运行（无 Docker）

需 Python 3.11+：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

访问 <http://localhost:8000/>。数据库文件自动创建于 `./data/plans.db`。

## 测试

前端结果归属规则（编辑失效、方案切换、过期响应丢弃）有 Node 回归测试，
无需浏览器与额外依赖（Node 18+）：

```bash
node tests/result_ownership.test.js
```

## 使用流程

1. 顶部填写方案名称，设置 d、g、求解时限，必要时添加禁用闭区间；
2. 在“话筒清单”中为每支设备填写 ID、候选频点（空格/逗号分隔），选择现用频点，
   需要保留现用频点的设备勾选 🔒 锁定；
3. 点击 **▶ 协调求解**：
   - 若锁定设备互相冲突或与禁用区间冲突，顶部红色面板列出具体冲突设备与规则，
     请先调整锁定频点或参数；
   - 否则展示频谱、每支设备的协调频点、分配/变更统计与最优性状态；
4. 点击 **保存方案** 入库；通过 **打开方案 ▾** 可重新打开历史方案，再次编辑、
   求解或保存。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/solve` | 提交方案进行约束求解（不落库） |
| GET | `/api/plans` | 已保存方案列表 |
| POST | `/api/plans` | 新建保存方案 |
| GET | `/api/plans/{id}` | 打开指定方案 |
| PUT | `/api/plans/{id}` | 更新方案 |
| DELETE | `/api/plans/{id}` | 删除方案 |

`POST /api/solve` 请求体示例：

```json
{
  "name": "跨年晚会",
  "minGap": 5,
  "imTolerance": 0,
  "timeLimit": 10,
  "forbidden": [{"low": 500, "high": 510}],
  "mics": [
    {"id": "A", "candidates": [520, 540, 560], "current": 520, "locked": true},
    {"id": "B", "candidates": [525, 545, 565], "current": null, "locked": false}
  ]
}
```

成功响应：

```json
{
  "status": "optimal",
  "optimal": true,
  "assignedCount": 2,
  "changeCount": 0,
  "solveTimeMs": 42,
  "timeLimitSec": 10,
  "phases": [
    {"phase": "max-assigned", "status": "OPTIMAL", "objective": -2, "order": 1},
    {"phase": "min-changes", "status": "OPTIMAL", "objective": 0, "order": 2}
  ],
  "assignment": [
    {"id": "A", "locked": true,  "current": 520, "assigned": true, "frequency": 520, "changed": false},
    {"id": "B", "locked": false, "current": null, "assigned": true, "frequency": 545, "changed": false}
  ],
  "conflicts": []
}
```

锁定集合冲突时 `status` 为 `"conflict"`，`conflicts` 数组逐项给出
`devices`、`rule`（禁用频点 / 最小频差 / 互调容差）与中文 `detail`；
时限内未证明最优时 `status` 为 `"feasible"`、`optimal` 为 `false`，
`assignment` 仍为可行解。

## 求解方法说明

求解器为每支话筒建立“候选频点”布尔变量与已分配变量，并对锁定设备固定现用
频点；最小频差与三阶互调约束通过半具体化（reified）分离约束，仅在相关设备
均已分配时生效。三个优化目标按层级依次求解 CP-SAT，每阶段将上一阶段最优值
固定，并将上一阶段解作为热启动，因此未证明最优也能及时返回可行解。
