# 代码审查 — 待修复 Bug 清单

> 说明：本文档由代码审查得出，记录的是**会导致实际误动作**的潜在 bug，非风格问题。
> 项目当前可正常运行，以下问题多在并发、边界值、状态同步场景下触发。
> 每条包含：位置、现象、建议修复方向。供后续修复参考。

---

## 后端 `app.py`

### B1. 并发计数被整表清空，可能导致超额调度（高优先级）
- **位置**：`recover_stale_annotation_tasks`（约 571 行）、`forget_annotation_tasks`（约 678 行）
- **现象**：两处都直接调用 `TASK_ACTIVE_BY_COMBO.clear()`，把**所有**模型组合的活跃任务计数清零。但此时其它组合可能仍有任务在运行。计数被清空后，`schedule_pending_annotation_tasks` 会误判为有空闲名额，导致同一组合并发任务数突破 `MAX_ACTIVE_TASKS_PER_COMBO`（10）的限制。
- **建议修复**：只针对受影响的 `task.model_name` 递减/移除对应计数，不要整表 `clear()`；或在清空后根据 DB 中真实处于 `running` 状态的任务重建计数字典。

### B2. `build_prompt` 的 `.format()` 只捕获了 KeyError
- **位置**：`build_prompt`（约 425-433 行）
- **现象**：`prompt_content.format(**row_data)` 仅 `except KeyError`。若 prompt 文本里含有未配对的 `{` / `}` 字面量，或形如 `{0}` 的位置占位符，`str.format` 会抛 `ValueError` / `IndexError`，未被捕获，导致整条标注任务直接 `failed`。
- **建议修复**：把异常捕获扩大为 `except (KeyError, IndexError, ValueError)`，回退使用原文。

### B3. `AnnotationResult` 的 (row_id, model_name) 缺少唯一约束
- **位置**：`AnnotationResult` 模型定义（约 77-88 行）、`run_annotation_task` 中的 "查 existing 再 update/insert" 逻辑（约 752-777 行）
- **现象**：代码靠"先查询是否存在、再决定 update 还是 insert"来保证"一行 + 一组合"只有一条结果，但数据库层面没有唯一索引。在 mock 延时（`strategies.py` 里的 `time.sleep`）+ 并发场景下，理论上仍可能插入重复记录。`/api/annotate` 有去重保护，所以现实风险较低，但属隐患。
- **建议修复**：给 `(row_id, model_name)` 增加唯一约束，写入时改用 upsert 语义。

---

## 前端 `static/app.js`

### B4. `row.id || row._id` 把 id=0 当作无效值（确信度最高）
- **位置**：多处，如 `renderTable`（约 829 行）、标注相关逻辑（约 1955、2253、2283 行附近）
- **现象**：到处使用 `const rowId = row.id || row._id` 或 `row.id || row._id || idx` 这类写法。当后端返回的主键 `id === 0` 时，`||` 会把 0 视为假值并回退到 `_id` / `idx`，导致勾选、标注、任务 key 匹配在整条链路上错位。
- **建议修复**：统一改用空值合并运算符 `row.id ?? row._id`。

### B5. 轮询无并发保护，存在竞态导致状态闪烁
- **位置**：`pollAnnotationTasks` / `startTaskPolling`（约 2360-2398 行）
- **现象**：轮询每 2 秒触发一次，且函数内部还会调用 `loadRows` / `loadStats`。若单次轮询耗时超过 2 秒，多个异步请求会叠加，交替写入 `activeAnnotationJobs` 与 `state.activeTaskSnapshot`，导致任务状态闪烁甚至丢失。
- **建议修复**：增加一个 `state._polling` 互斥标志，进入时 `if (state._polling) return;`，在 `finally` 中复位。

### B6. 范围步进按钮会先重置选区
- **位置**：`adjustRangeBoundary`（约 1056 行）
- **现象**：函数第一行就调用 `updateRangeSelector()`，而该函数在某些条件下（如 `range.total !== state.total`）会把 `start`/`end` 重置为 1 并将 `touched` 置 false，导致首次点击步进按钮无法正确累加边界。调用顺序错误。
- **建议修复**：删除开头那次 `updateRangeSelector()` 调用，仅保留修改边界之后的那次刷新。

### B7. 弹窗确认前改动范围，会用旧 id 执行标注
- **位置**：`openBulkActionConfirm` / `executeBulkActionConfirm` / `batchAnnotate`（约 1994、2060、2075 行）
- **现象**：`openBulkActionConfirm` 异步通过 `fetchRangeRowIds()` 取得 ids 存入 `state.pendingBulkIds`。若用户在弹窗确认前拖动范围滑块改变了选区，执行时仍使用旧的 ids，导致实际标注的行与界面显示的范围不一致。
- **建议修复**：在确认执行时重新拉取/校验当前范围 id，或在弹窗打开期间锁定范围滑块。

---

## 优先级建议
1. **B4**（id=0 真值陷阱，影响选择/标注/任务匹配全链路）
2. **B1**（并发计数清空导致超额调度）
3. **B5**（轮询竞态）
4. 其余按场景排期修复。
