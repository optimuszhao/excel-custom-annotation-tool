# 数据飞轮 — 产品需求文档 (PRD)

## 1. 项目概述

### 1.1 产品定位
数据飞轮是一个AI标注调试台系统，用于大模型驱动的数据标注流程。支持多场景、多模型、多Prompt、多角色标注，提供并发控制、任务调度、标注结果管理、混淆矩阵统计等核心功能。

### 1.2 技术栈
- **后端**: FastAPI (Python) + SQLAlchemy ORM
- **数据库**: SQLite
- **前端**: HTML5 + JavaScript + Tailwind CSS
- **并发**: ThreadPoolExecutor + 多线程锁机制
- **文件处理**: Pandas (Excel读写) + YAML (配置)
- **模板引擎**: Jinja2

### 1.3 系统架构概览
```
前端页面（HTML+JS）
    ↓ (AJAX)
FastAPI REST API
    ↓
SQLAlchemy ORM
    ↓
SQLite 数据库

后台线程：
- 标注任务调度器（5秒轮询恢复故障任务）
- 定时同步器（1小时同步DB→本地文件）
- 并发执行器（ThreadPoolExecutor，最多20个worker）
```

---

## 2. 数据库设计

### 2.1 表结构详解

#### 表 1: scenes（场景表）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| name | String | 场景名称（如"SPN"） | UNIQUE, NOT NULL |
| description | Text | 场景描述 | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 标注应用的多场景支持（不同业务、不同数据集）。一个系统可有多个场景，每个场景独立管理Prompt、知识、规则。

---

#### 表 2: excel_files（上传的Excel文件记录）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| file_name | String | 存储文件名（UUID前缀） | NOT NULL |
| original_file_name | String | 原始上传文件名 | NOT NULL |
| scene_id | Integer | 关联场景 | FK → scenes.id, 可空 |
| total_rows | Integer | 总行数 | 默认0 |
| annotated_count | Integer | 已标注行数 | 默认0 |
| columns_info | Text | 列信息（JSON） | 可空 |
| display_columns | Text | 显示列配置（JSON） | 可空 |
| file_path | String | 本地文件路径 | 可空 |
| cot_names | Text | COT名称列表（JSON数组） | 可空 |
| annotate_config | Text | 文件级标注默认配置（JSON） | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 管理上传的Excel数据文件，支持文件级显示列配置、COT名称提取。

**索引**: `ix_excel_files_scene_id_created_at` (scene_id, created_at)

---

#### 表 3: excel_rows（Excel原始数据行）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| file_id | Integer | 关联文件 | FK → excel_files.id, 可空 |
| file_name | String | 冗余字段 | **[DEPRECATED]** 通过file_id JOIN获取 |
| row_index | Integer | 行号（0开始） | NOT NULL |
| data | Text | 行数据（JSON） | NOT NULL |
| human_answer | String | 人工标注答案 | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 存储Excel的原始数据行。

**索引**: `ix_excel_rows_file_id_row_index` (file_id, row_index)

**数据示例**:
```json
{
  "序号": 1,
  "chat_question": "如何使用API？",
  "chat_answer": "可以调用xxx接口",
  "api调用记录1": "GET /api/v1/...",
  "cot名称": "分类1"
}
```

---

#### 表 4: annotation_tasks（标注任务）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | String(36) | 主键（UUID） | PK |
| file_id | Integer | 目标文件 | FK → excel_files.id, 可空 |
| scene_id | Integer | 关联场景 | FK → scenes.id, 可空 |
| **[废弃]** row_id | Integer | 已废弃 | 历史数据兼容 |
| model_name | String | 模型显示名（如"qwen-plus(方案A)"） | NOT NULL, 默认"" |
| model_config | String | 模型配置文件名 | NOT NULL, 默认"" |
| strategy | String | 标注方案（方案A/B/C） | 默认"方案A" |
| prompt_names | Text | 使用的Prompt名称列表（JSON） | 可空 |
| concurrency | Integer | 并发数 | 默认1，最大20 |
| total_rows | Integer | 总行数 | 默认0 |
| success_count | Integer | 成功标注数 | 默认0 |
| failed_count | Integer | 失败标注数 | 默认0 |
| **[废弃]** accuracy/recall/precision_/f1_score | Float | 统计字段 | **改为动态聚合，不再写入DB** |
| **[废弃]** result/label/match_type/row_id/prompt_version | Text | 单行结果 | 已废弃，改用AnnotationResult表 |
| status | String | 任务状态 | `pending/running/success/failed/cancelled` |
| error | Text | 错误信息 | 可空 |
| row_data | Text | 标注目标行ID（JSON） | 格式: `[1,2,3]` 或 `{"row_start":1,"row_end":10}` 或 null(全量) |
| prompts | Text | Prompt配置（JSON） | 标注时读取 |
| knowledge | Text | 知识库配置（JSON） | 标注时读取 |
| duration_ms | Integer | 总耗时(毫秒) | 可空 |
| current_row_id | Text | 当前标注行ID列表（JSON） | **内存维护，勿写DB** |
| created_at | DateTime | 创建时间 | 默认 UTC |
| started_at | DateTime | 开始执行时间 | 可空 |
| finished_at | DateTime | 完成时间 | 可空 |

**用途**: 记录批量标注任务的元信息与进度。

**状态流转**: `pending` → `running` → `success/failed/cancelled`

**索引**: `ix_annotation_tasks_file_id_created_at` (file_id, created_at)

**关键字段说明**:
- `model_name`: 组合字段，格式为 `{model_config_name}({strategy_name})`
- `row_data`: 支持三种格式来灵活指定标注范围
- `current_row_id`: 在运行时由内存字典 `TASK_CURRENT_ROWS` 维护（防止DB频繁写入）

---

#### 表 5: annotation_results（标注结果）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| task_id | String(36) | 关联任务 | FK → annotation_tasks.id, 可空 |
| row_id | Integer | 关联数据行 | FK → excel_rows.id, 可空 |
| model_name | String | 模型名 | NOT NULL |
| prompt_name | String | Prompt名称 | 可空，特殊值: `__merged__`, `__error__`, `__default__` |
| prompt_version | String | Prompt版本 | 可空 |
| result | Text | 标注结果（JSON）| 包含所有返回字段 |
| label | String | 标注标签值 | 通常是result_label_field对应的值 |
| merged_label | String | 多Prompt合并标签 | 可空 |
| match_type | String | 匹配类型 | `TP/FP/TN/FN/UNKNOWN` |
| duration_ms | Integer | 单行耗时(毫秒) | 可空 |
| error | Text | 错误信息 | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |

**用途**: 存储每行每个Prompt的标注结果。支持多Prompt多角色标注。

**唯一约束**: `uq_task_row_prompt` (task_id, row_id, prompt_name)

**索引**: 
- `ix_annotation_results_task_id_row_id` (task_id, row_id)
- `ix_annotation_results_row_id_model_name` (row_id, model_name)

**特殊prompt_name值**:
- `__merged__`: 多Prompt合并后的结果
- `__error__`: 标注异常
- `__default__`: 无指定Prompt时的默认值

---

#### 表 6: prompts（Prompt文件DB管理）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| scene_id | Integer | 关联场景 | FK → scenes.id, 可空 |
| name | String | Prompt名称 | NOT NULL |
| content | Text | Prompt模板内容 | NOT NULL |
| file_type | String | 文件扩展名 | 默认".prompt" |
| role_name | String | 角色名字 | 可空，用于多角色标注 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: DB管理Prompt文件，支持版本控制、角色标记。

**唯一约束**: `uq_prompts_scene_name` (scene_id, name)

**Prompt模板示例**:
```
问题：{chat_question}
回答：{chat_answer}

请判断上述回答是否正确。
```
Prompt执行时会用rule.json中的annotate_fields对应行数据填充占位符。

---

#### 表 7: knowledge_files（知识库文件DB管理）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| scene_id | Integer | 关联场景 | FK → scenes.id, 可空 |
| name | String | 知识文件名 | NOT NULL |
| content | Text | 文件内容 | NOT NULL |
| file_type | String | 文件类型 | `.json`, `.jsonl`, `.txt` |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 管理标注过程所需的知识库（规则表、参考资料等）。

**唯一约束**: `uq_knowledge_files_scene_name` (scene_id, name)

---

#### 表 8: rule_configs（标注规则配置）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| scene_id | Integer | 关联场景（1:1） | FK → scenes.id, UNIQUE, 可空 |
| annotate_fields | Text | 标注字段列表（JSON） | 可空 |
| answer_field | String | 人工标注答案字段名 | 可空 |
| result_label_field | String | 大模型输出标签字段名 | 可空 |
| excel_fields | Text | Excel显示字段列表（JSON） | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 定义场景的数据格式与标注规则。采用**双写同步**机制：DB为主，同时写入`data/rules/{scene_name}.json`。

**RuleConfig.scene_id NULL防护**: 查询时需使用`is_(None)`而非`== None`。

**配置示例**:
```json
{
  "annotate_fields": ["chat_question", "chat_answer"],
  "answer_field": "人工标注答案",
  "result_label_field": "大模型标注答案",
  "excel_fields": ["序号", "chat_question", "chat_answer", "cot名称"]
}
```

---

#### 表 9: error_books（错题集）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| scene_id | Integer | 关联场景 | FK → scenes.id, 可空 |
| file_id | Integer | 关联数据集 | FK → excel_files.id, 可空 |
| cot_name | String | COT分类名 | 可空 |
| row_id | Integer | 关联数据行 | FK → excel_rows.id, 可空 |
| original_data | Text | 原始数据（JSON） | 可空，有row_id时通过JOIN获取 |
| expected_answer | String | 期望答案 | 可空 |
| actual_output | String | 实际输出 | 可空 |
| error_reason | Text | 错误原因 | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 记录标注失败/错误的样本，用于模型改进与分析。

**索引**: `ix_error_books_scene_file_cot` (scene_id, file_id, cot_name)

**数据策略**:
- 有row_id时：original_data为NULL，通过JOIN excel_rows.data获取
- 无row_id时：original_data独立存储

---

#### 表 10: chat_sessions（对话会话）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | String(36) | 主键（UUID） | PK |
| model_name | String | 模型名 | 可空 |
| title | String | 会话标题 | 可空 |
| created_at | DateTime | 创建时间 | 默认 UTC |
| updated_at | DateTime | 修改时间 | 自动更新 |

**用途**: 模型对话功能的会话管理。

---

#### 表 11: chat_messages（对话消息）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | Integer | 主键，自增 | PK |
| session_id | String(36) | 关联会话 | FK → chat_sessions.id, NOT NULL |
| role | String | 消息角色（user/assistant） | NOT NULL |
| content | Text | 消息内容 | NOT NULL |
| created_at | DateTime | 创建时间 | 默认 UTC |

**用途**: 存储对话消息记录。

**索引**: `ix_chat_messages_session_id_created_at` (session_id, created_at)

---

### 2.2 表间关系（ER关系）

```
scenes (1) ──── (多) excel_files
                        ↓ (1)
                    (多) excel_rows
                         ↓ (多) annotation_results
                              ↓ (多)
                         annotation_tasks

scenes (1) ──── (多) prompts
scenes (1) ──── (多) knowledge_files
scenes (1) ──── (多) error_books
scenes (1) ──── (1) rule_configs

excel_files (1) ──── (多) error_books
excel_rows (1) ──── (多) error_books
```

---

### 2.3 关键设计说明

**1. 废弃字段与演进**

annotation_tasks 表中的以下字段已弃用，但保留以支持历史数据兼容：
- `row_id`, `result`, `label`, `match_type`, `prompt_version`: 改用annotation_results表
- `accuracy`, `recall`, `precision_`, `f1_score`: 改为动态聚合，在查询时计算

**2. 统计指标动态聚合**

不再持久化混淆矩阵相关字段，而是在查询时从annotation_results表动态计算：
```python
TP = count(match_type == "TP")
FP = count(match_type == "FP")
TN = count(match_type == "TN")
FN = count(match_type == "FN")

accuracy = (TP + TN) / (TP + TN + FP + FN)  # 排除UNKNOWN
recall = TP / (TP + FN)
precision = TP / (TP + FP)
f1_score = 2*TP / (2*TP + FP + FN)
```

**3. current_row_id 内存化**

annotation_tasks.current_row_id 存储在内存字典 `TASK_CURRENT_ROWS` 中，而非频繁写DB：
```python
TASK_CURRENT_ROWS: Dict[str, set] = {}  # task_id → {row_id1, row_id2, ...}
```
仅在任务完成时清理。这避免了高并发下的DB锁竞争。

**4. UPSERT机制**

annotation_results 采用UPSERT（存在则更新，不存在则插入）：
```python
upsert_annotation_result(db, task_id, row_id, prompt_name, **kwargs)
```
确保多Prompt标注时同一行不产生重复记录。

---

## 3. 场景管理

### 3.1 功能描述
场景（Scene）是系统的多租户隔离单位，代表不同的业务类型或标注任务分类。每个场景独立管理自己的Prompt、知识库、规则配置、数据集。

### 3.2 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/scenes` | 获取所有场景列表 |
| POST | `/api/scenes` | 创建新场景 |
| PUT | `/api/scenes/{scene_id}` | 修改场景 |
| DELETE | `/api/scenes/{scene_id}` | 删除场景（检查关联资源） |

### 3.3 删除约束
删除场景前会检查是否存在关联的Excel文件、Prompt、知识文件、标注任务。若有则拒绝删除并返回关联资源统计。

---

## 4. 规则配置（场景级）

### 4.1 功能描述
规则配置（RuleConfig）定义该场景的标注元数据格式：
- `annotate_fields`: 标注时需要提取的字段（传给Prompt）
- `answer_field`: 人工标注答案的字段名
- `result_label_field`: 大模型输出标签的字段名
- `excel_fields`: Excel显示的字段列表

### 4.2 双写同步机制
规则配置同时存储于**数据库**与**本地文件**（`data/rules/{scene_name}.json`）：
- 修改API: 先写DB，后写文件
- 启动扫描: 若本地文件与DB不一致，本地文件为权威源，更新DB
- 定时同步: 每小时将DB同步到本地文件

### 4.3 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/rules/{scene_id}` | 获取场景规则配置 |
| PUT | `/api/rules/{scene_id}` | 更新规则配置（支持JSON编辑器模式） |

### 4.4 NULL防护
RuleConfig.scene_id 可能为NULL（兼容数据），查询时必须使用：
```python
db.query(RuleConfig).filter(RuleConfig.scene_id.is_(None))
```
而非 `== None`，因为SQL中 `NULL = NULL` 返回假。

---

## 5. Excel数据管理

### 5.1 文件上传
- 端点: `POST /api/excel/upload`
- 解析Excel：pandas.read_excel()
- 存储路径: `data/datasets/{scene_name}/{uuid}_{filename}`
- 创建ExcelFile记录，逐行插入ExcelRow表
- 提取COT名称列（大小写不敏感匹配"cot名称"）

### 5.2 多文件处理
- `GET /api/excel/list` - 按场景/文件名/排序条件获取列表（分页）
- 支持删除文件与关联标注结果
- 支持补全历史文件的COT名称

### 5.3 数据行管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/rows` | 全量数据行列表（支持搜索、筛选、排序） |
| GET | `/api/rows/range-ids` | 按范围返回行ID（用于前端范围选择） |
| POST | `/api/rows/by-ids` | 按ID列表批量获取行详情 |
| PUT | `/api/workbench/rows/{row_id}` | 编辑行数据 |
| DELETE | `/api/workbench/rows/{row_id}` | 删除行及关联标注结果 |
| DELETE | `/api/workbench/rows/{row_id}/annotations` | 取消行标注（保留行数据） |

### 5.4 搜索与过滤
- 文本搜索：对数据、人工答案、标注结果、匹配类型进行全文检索
- 过滤选项：按匹配类型(TP/FP/TN/FN)、未标注状态过滤
- 排序：按ID、人工答案、行号、匹配类型、数据字段排序

---

## 6. 标注工作台

### 6.1 整体布局与功能架构

标注工作台是系统的核心功能模块，提供：
1. **数据行展示** - 分页表格显示（可配置显示列）
2. **任务创建** - 创建批量标注任务
3. **任务执行** - 并发执行标注（可视化进度）
4. **行级状态** - 显示每行的标注进度（未标注、排队中、标注中、已标注、失败）
5. **任务管理** - 任务列表、详情、取消、删除
6. **统计指标** - 混淆矩阵、准确率、召回率等动态计算

### 6.2 显示列配置

支持**三级配置**（优先级递减）：
1. **文件级配置** (`excel_files.display_columns`) - 最高优先级
2. **全局级配置** (规则配置中的 `excel_fields`)
3. **默认配置** (所有列)

配置值为JSON数组，如: `["序号", "chat_question", "chat_answer"]`

**API**: `PUT /api/rule/display-columns` - 同步更新规则配置的display_columns

### 6.3 创建标注任务

**请求**: `POST /api/workbench/annotate`

**核心参数**:
```json
{
  "file_id": 1,
  "row_ids": [1, 2, 3],           // 可选：指定行；否则全量或按范围
  "row_start": null,               // 可选：按row_index范围（包含）
  "row_end": null,                 // 可选：按row_index范围（包含）
  "model_config": "qwen-plus.yaml",// 必须：模型配置文件名
  "strategy": "方案A",              // 必须：标注策略
  "prompt_names": ["api_label.prompt", "api_reason.prompt"],  // 可选：多Prompt
  "concurrency": 5                 // 并发数，限制1-20
}
```

**任务状态流转**:
```
pending (队列等待)
  ↓
running (执行中)
  ↓
success / failed / cancelled
```

**返回值**: `{"task_id": "uuid", "status": "pending", "total_rows": 100}`

### 6.4 并发控制机制

**全局限制**:
- `MAX_TASK_CONCURRENCY = 20` - 系统最多同时运行20个标注任务
- `MAX_ACTIVE_TASKS_PER_COMBO = 10` - 同一模型策略组合最多10个并发任务

**数据结构**:
```python
TASK_RUNNING_IDS: set[str]  # 当前运行中的任务ID集合
TASK_ACTIVE_BY_COMBO: dict[str, int]  # 每个model_name的活跃任务数
TASK_SCHEDULER_LOCK: Lock  # 保护上述数据结构
```

**调度流程** (`schedule_pending_annotation_tasks`):
1. 按model_name分组聚合pending任务
2. 轮询分配可用并发槽位
3. 遵守combo_limit限制（根据concurrency值计算）
4. 更新任务状态为running，并提交到ThreadPoolExecutor

### 6.5 标注任务执行 (`execute_workbench_annotation_task`)

**核心流程**:
```
1. 读取任务配置 (model_config, strategy, prompts, knowledge, concurrency)
2. 解析row_data确定标注范围
   - null → 全量标注
   - [1,2,3] → 指定行
   - {row_start, row_end} → 按row_index范围
3. 从DB读取ExcelRow数据与RuleConfig
4. 为每行创建标注任务子任务
5. 使用ThreadPoolExecutor并发执行（限制并发数 = min(task_concurrency, 20)）
6. 对每行执行：
   a. 从内存TASK_CURRENT_ROWS添加当前行ID
   b. 获取全局SEMAPHORE信号量（限制总并发20个）
   c. 调用strategies.py中的标注函数
   d. 解析标注结果，调用calc_match_type()计算匹配类型
   e. 若多Prompt则进行结果合并（策略：多数投票）
   f. UPSERT标注结果到annotation_results表
   g. 从TASK_CURRENT_ROWS移除当前行ID
7. 所有行完成后，重新计算混淆矩阵，更新任务统计
8. 设置任务为success，记录duration_ms
```

**追加标注** (`task_id` 参数存在):
- 直接对指定行执行标注
- 任务状态重置为running（若已完成）
- 不走调度器排队，直接提交后台执行
- 总行数增量累加

### 6.6 行级标注状态

**工作台API**: `GET /api/workbench/rows?file_id=1&task_id=uuid`

**行状态枚举**:
- `未标注` - 无标注结果
- `排队中` - 活跃任务中，尚未开始标注
- `标注中` - 当前正在标注（从内存TASK_CURRENT_ROWS查询）
- `已标注` - 有标注结果且无错误
- `失败` - 标注异常（prompt_name == '__error__'）
- `任务创建中` - 待兼容旧状态

**状态计算逻辑**:
```python
def get_row_status(row_id):
    # 若指定了task_id且非活跃任务，只显示该任务结果
    if task_id and task_id != active_task.id:
        return "已标注" / "失败" / "未标注"
    
    # 活跃任务逻辑
    if active_task:
        if active_task.status == "pending":
            return "任务创建中"  # 若行在row_data目标范围
        if active_task.status == "running":
            if row_id in TASK_CURRENT_ROWS[active_task.id]:
                return "标注中"
            if row_id in error_row_ids:
                return "失败"
            if row_id in annotated_row_ids:
                return "已标注"
            if row_id in row_data target range:
                return "排队中"
    
    # 无活跃任务，检查task_id的结果
    if effective_task_id:
        return "已标注" / "失败"
    return "未标注"
```

### 6.7 多Prompt多角色标注与结果合并

**多Prompt执行**:
- 为task中每个prompt_name循环标注同一行
- 调用strategies.py中对应的strategy函数
- 每个标注结果分别保存为一条annotation_result记录（prompt_name不同）

**结果合并策略**:
- 若多个Prompt的标注结果存在，进行合并：
  - 提取每个结果的label值
  - 计算多数投票(majority voting)
  - 若无法合并（如全部不同），取第一个Prompt结果
  - 合并结果保存为`prompt_name == "__merged__"`的记录

**示例**:
```
Prompt1 (api_label.prompt)  → label: "是"
Prompt2 (api_reason.prompt) → label: "是"
Prompt3 (xxx)               → label: "否"

Merged: label "是" (2票vs1票，多数投票)
```

### 6.8 任务取消与恢复

**取消**: `POST /api/workbench/tasks/{task_id}/cancel`
- 标记状态为cancelled
- 从调度器中移除（释放并发槽位）
- 后台线程停止该任务的进一步处理

**故障恢复** (`annotation_recovery_loop`，5秒轮询一次):
1. `reset_interrupted_annotation_tasks()` - 启动时重置所有running任务为pending
2. `recover_orphaned_annotation_tasks()` - 发现DB中running但不在TASK_RUNNING_IDS中的任务，重置为pending
3. `recover_stale_annotation_tasks()` - 若任务started_at距今超过30分钟，视为僵尸任务，重置为pending

### 6.9 任务列表与统计

**API**: `GET /api/workbench/tasks?file_id=1`

**返回统计指标**:
- 动态聚合：优先取`__merged__`结果，否则取去重的普通结果
- 返回 accuracy/recall/precision/f1_score
- 对于running/pending的任务实时统计

**运行中任务的进度**:
```python
completed_count = success_count
annotating_count = len(TASK_CURRENT_ROWS[task_id])
queuing_count = max(0, total_rows - completed_count - annotating_count - failed_rows)
```

### 6.10 轮询与实时刷新

前端通过以下API支持实时监控：
- `GET /api/workbench/task-status?task_ids=uuid1,uuid2,...` - 批量查询任务状态
- `GET /api/workbench/stats?file_id=1&task_id=uuid` - 查询统计指标

---

## 7. Prompt管理

### 7.1 功能描述
Prompt是标注指令模板，支持变量替换。每个Prompt关联一个场景，支持版本管理与角色标记。

### 7.2 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/prompts?scene_id=1` | 获取场景Prompt列表 |
| POST | `/api/prompts` | 创建Prompt（名称唯一性校验） |
| PUT | `/api/prompts/{prompt_id}` | 修改Prompt内容/名称/角色 |
| DELETE | `/api/prompts/{prompt_id}` | 删除Prompt |
| POST | `/api/prompts/check` | 检查占位符有效性 |
| POST | `/api/prompts/sync-local` | 同步到本地文件 |

### 7.3 角色名字功能
- `role_name` 字段支持为Prompt标记角色（如"安全审核员"）
- 多角色标注时，可根据role_name区分不同的标注视角
- 在前端标注设置中显示角色名供选择

### 7.4 变量替换机制

Prompt模板使用Python format语法：`{字段名}`

**标注执行流程**:
```python
rule_config = load_rule_for_scene(scene_id)
annotate_fields = rule_config['annotate_fields']  # ["chat_question", "chat_answer"]

# 从行数据中提取annotate_fields对应的值
row_data = {
    "chat_question": "如何使用API？",
    "chat_answer": "调用xxx接口"
}

# Prompt模板
template = "问题：{chat_question}\n回答：{chat_answer}\n是否正确？"

# 填充
filled_prompt = template.format(**row_data)
# 结果: "问题：如何使用API？\n回答：调用xxx接口\n是否正确？"
```

### 7.5 占位符检查
API `/api/prompts/check` 验证：
- 缺失的必需占位符（在annotate_fields中但不在Prompt中）
- 多余的占位符（在Prompt中但不在annotate_fields中）
- 返回警告信息

---

## 8. 知识库管理

### 8.1 功能描述
知识文件为标注过程提供参考资料（规则表、分类指南等）。与Prompt配套使用。

### 8.2 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/knowledge?scene_id=1` | 获取场景知识文件列表 |
| POST | `/api/knowledge` | 上传知识文件 |
| PUT | `/api/knowledge/{knowledge_id}` | 修改知识文件 |
| DELETE | `/api/knowledge/{knowledge_id}` | 删除知识文件 |
| POST | `/api/knowledge/sync-local` | 同步到本地文件 |

### 8.3 文件类型
- `.txt` - 纯文本（如分类指南）
- `.json` - JSON格式（如规则表）
- `.jsonl` - JSONL格式（如数据列表）

### 8.4 标注关联
标注时，knowledge列表通过strategies.py的knowledge_list参数传入：
```python
def strategy_func(prompt, row_data, model_config_name, prompt_list, concurrency, knowledge_list):
    # knowledge_list 格式: [{"name": "知识文件名", "content": "文件内容"}]
    # 可在strategy中使用knowledge内容辅助标注决策
```

---

## 9. 错题集管理

### 9.1 功能描述
错题集记录标注失败或有问题的样本，用于分析模型性能瓶颈。支持COT分类。

### 9.2 COT分类结构
```
场景 (Scene)
  └─ 数据集 (ExcelFile)
      └─ COT名称 (ErrorBook.cot_name)
          └─ 错题列表 (多条ErrorBook记录)
```

### 9.3 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/error-books?scene_id=1&file_id=1&cot_name=xxx` | 分页查询错题（支持搜索） |
| POST | `/api/error-books` | 新增错题 |
| PUT | `/api/error-books/{error_id}` | 编辑错题 |
| DELETE | `/api/error-books/{error_id}` | 删除错题 |
| GET | `/api/error-books/cot-names?scene_id=1` | 获取该场景COT名称列表 |
| GET | `/api/error-books/datasets?scene_id=1` | 获取该场景数据集列表 |

### 9.4 原始数据获取策略

**降级策略**（降低数据冗余）:
1. 若 `row_id` 非空：通过 `JOIN excel_rows` 实时获取 `data` 字段
2. 若 `row_id` 为空：使用 `original_data` 字段值（可能是快照或独立输入）

**好处**: 支持对已删除行的错题保留（通过独立original_data），也支持对存在行的动态引用。

### 9.5 COT名称提取

**优先级**（从高到低）:
1. ExcelFile.cot_names 字段（JSON数组，Excel上传时自动提取）
2. ErrorBook.cot_name 字段（兼容旧数据）

**提取逻辑**（Excel上传时）:
- 查找列名（大小写不敏感）为"cot名称"的列
- 提取该列的唯一非空值
- 存储为JSON数组到ExcelFile.cot_names

---

## 10. 模型对话

### 10.1 功能描述
提供模型对话界面，支持多轮对话与会话管理。当前实现为Mock调用。

### 10.2 API列表

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/chat/models` | 获取可用模型列表 |
| GET | `/api/chat/sessions` | 获取会话列表 |
| POST | `/api/chat/sessions` | 创建新会话 |
| GET | `/api/chat/sessions/{session_id}/messages` | 获取会话消息 |
| POST | `/api/chat/sessions/{session_id}/messages` | 发送消息并获取回复 |

### 10.3 Mock调用机制

当前系统使用MOCK实现，不调用真实大模型：
```python
MODEL_CALLERS = {
    "qwen-plus": call_qwen_plus,       # Mock: 2秒延迟
    "deepseek-chat": call_deepseek_chat,
    "gpt-4.1-mini": call_gpt4_mini,
}
```

**设计决策**: 保持MOCK状态便于前端开发。接入真实模型时，替换MODEL_CALLERS中的函数即可。

---

## 11. 统计指标

### 11.1 混淆矩阵计算

**match_type分类**:
```python
def calc_match_type(human_answer, label):
    h = normalize_binary_label(human_answer)  # 转为"是"或"否"或""
    l = normalize_binary_label(label)
    
    if h=="是" and l=="是": return "TP"  (True Positive)
    if h=="是" and l=="否": return "FN"  (False Negative)
    if h=="否" and l=="是": return "FP"  (False Positive)
    if h=="否" and l=="否": return "TN"  (True Negative)
    return "UNKNOWN"  (人工答案或标注答案为空或无效)
```

**标签规范化**:
- YES值: "是", "对", "正确", "yes", "YES", "true", "True", "1"
- NO值: "否", "错", "错误", "no", "NO", "false", "False", "0"
- 其他: 返回空字符串

### 11.2 指标计算公式

**准确率(Accuracy)** - 排除UNKNOWN:
```
accuracy = (TP + TN) / (TP + TN + FP + FN)
```

**召回率(Recall)**:
```
recall = TP / (TP + FN)
```

**精确率(Precision)**:
```
precision = TP / (TP + FP)
```

**F1分数**:
```
f1 = 2*TP / (2*TP + FP + FN)
```

### 11.3 统计API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/stats?model=qwen-plus` | 全量统计（按模型过滤） |
| GET | `/api/stats/all` | 所有模型的统计汇总 |
| GET | `/api/workbench/stats?file_id=1&task_id=uuid` | 工作台统计（任务级别） |

---

## 12. 导出Excel

### 12.1 新版导出 (按file_id + task_id)

**API**: `POST /api/export`

**参数**:
```json
{
  "file_id": 1,
  "task_id": "uuid"  // 可选，不传则取最新任务
}
```

**生成4-Sheet Excel**:

| Sheet名 | 内容 | 说明 |
|---------|------|------|
| 标注数据 | 原始数据行 + 标注结果列 | 每行为标注数据记录 |
| 统计数据 | TP/FP/TN/FN/准确率等 | 单行统计汇总 |
| 标注明细 | 每行每个Prompt的标注详情 | 耗时、Prompt名称等 |
| 导出信息 | 元数据（导出时间、模型名等） | 供溯源参考 |

**文件名示例**: `标注100条（准确率95%）+qwen-plus(方案A)+test_data.xlsx`

---

## 13. 全局数据同步

### 13.1 定时同步机制

**触发**: 应用启动时立即执行一次，后续每小时自动执行

**同步内容** (DB → 本地文件):

1. **Prompt同步** → `data/prompts/{scene_name}/`
   - 逐个Prompt写文件
   - 删除DB中已删除的本地Prompt文件
   - 结果: `data/prompts/SPN/api_label.prompt`

2. **知识库同步** → `data/knowledge/{scene_name}/`
   - 写知识文件内容
   - 结果: `data/knowledge/SPN/rules.json`

3. **规则同步** → `data/rules/{scene_name}.json`
   - 序列化RuleConfig为JSON
   - 结果: `data/rules/SPN.json`

4. **错题集同步** → `data/error_books/{scene_name}_errors.jsonl`
   - 逐行JSONL格式
   - 使用row_id JOIN策略获取original_data
   - 结果: 一行一个JSON对象

**状态维护**: SYNC_STATUS全局变量记录最后同步时间与结果

### 13.2 启动文件扫描

应用启动时(`scan_and_sync_local_files`)扫描本地文件，若发现与DB不一致，**本地文件为权威源**，更新DB。

---

## 14. 关键设计决策

### 14.1 current_row_id 内存化

**为什么?**
- 频繁写DB会产生行锁竞争
- 内存字典操作快速、原子性好
- 任务完成时清理，无数据丢失风险

**实现**:
```python
TASK_CURRENT_ROWS: Dict[str, set] = {}  # task_id → set of row_ids
TASK_CURRENT_ROWS_LOCK = threading.Lock()  # 线程锁保护

def _update_current_row_ids(task_id, add_id=None, remove_id=None):
    with TASK_CURRENT_ROWS_LOCK:
        current = TASK_CURRENT_ROWS.setdefault(task_id, set())
        if add_id is not None: current.add(add_id)
        if remove_id is not None: current.discard(remove_id)
```

### 14.2 统计字段动态聚合

**为什么不持久化?**
- 追加标注时无需重新计算整个任务的统计
- 避免统计字段与实际annotation_results数据不一致
- 支持灵活的数据修正（删除错误结果后统计自动更新）

**实现**: 查询时从annotation_results表动态聚合

### 14.3 annotation_results UPSERT机制

**为什么?**
- 同一行多次标注（如重试）应覆盖旧结果而非追加
- 多Prompt标注时需要确保同一行不重复

**实现**:
```python
def upsert_annotation_result(db, task_id, row_id, prompt_name, **kwargs):
    # task_id为None时用'__legacy__', prompt_name为None时用'__default__'替代
    existing = db.query(AnnotationResult).filter(
        AnnotationResult.task_id == task_id,
        AnnotationResult.row_id == row_id,
        AnnotationResult.prompt_name == prompt_name
    ).first()
    if existing:
        # 更新
    else:
        # 插入
```

### 14.4 并发控制（TASK_ACTIVE_BY_COMBO）

**为什么?**
- 防止同一model_name的标注任务无限堆积
- 不同模型可独立调度，互不阻塞

**实现**:
```python
TASK_ACTIVE_BY_COMBO: defaultdict[str, int]  # model_name → 当前活跃任务数
# 模型名格式: "qwen-plus(方案A)"

# 调度时检查
combo_limit = min(task.concurrency, MAX_ACTIVE_TASKS_PER_COMBO)  # 10
if TASK_ACTIVE_BY_COMBO[model_name] < combo_limit:
    # 准许调度
```

---

## 15. 故障恢复与高可用

### 15.1 任务恢复机制

**后台恢复线程** (annotation_recovery_loop，5秒轮询):

1. **孤立任务恢复** (`recover_orphaned_annotation_tasks`)
   - 发现status=running但不在TASK_RUNNING_IDS中的任务
   - 重置为pending以便重新调度
   - 场景: 后台线程崩溃、DB与内存状态不一致

2. **僵尸任务检测** (`recover_stale_annotation_tasks`)
   - 若task.started_at距今超过30分钟，视为僵尸
   - 重置为pending
   - 场景: 标注逻辑陷入无限循环

3. **启动重置** (`reset_interrupted_annotation_tasks`)
   - 应用启动时清空TASK_RUNNING_IDS，重置所有running任务为pending
   - 场景: 应用强制停止、进程崩溃

### 15.2 全局并发信号量

```python
GLOBAL_ANNOTATION_SEMAPHORE = threading.Semaphore(20)  # 最多20个并行标注worker

# 标注单行时
GLOBAL_ANNOTATION_SEMAPHORE.acquire()
try:
    # 执行标注
finally:
    GLOBAL_ANNOTATION_SEMAPHORE.release()
```

保证总并发数不超过20，防止资源耗尽。

---

## 16. 前端菜单与页面结构

### 16.1 导航菜单项

| 菜单项 | 路由 | 对应模块 | 说明 |
|--------|------|---------|------|
| Excel 数据管理 | `/` | index.html | 上传、管理数据文件 |
| 标注工作台 | `/workbench` | workbench.html | 核心标注界面 |
| Prompt管理 | `/prompt-manage` | prompt_manage.html | 编辑Prompt模板 |
| 知识库管理 | `/knowledge-manage` | knowledge_manage.html | 管理知识文件 |
| 规则配置 | `/rule-config` | rule_config.html | 配置标注规则 |
| 错题集 | `/error-book` | error_book.html | 浏览错题 |
| 模型对话 | `/model-chat` | model_chat.html | 与模型对话 |
| 统计数据 | `/statistics` | statistics.html | 查看统计指标 |
| 任务管理 | `/task-manage` | task_manage.html | 管理标注任务 |

### 16.2 核心JS模块

| 文件 | 功能 |
|------|------|
| common.js | 公共工具函数、API封装 |
| components.js | 可复用UI组件 |
| workbench.js | 标注工作台主逻辑 |
| task_manage.js | 任务管理逻辑 |
| excel_manage.js | Excel文件管理 |
| prompt_manage.js | Prompt编辑 |
| knowledge_manage.js | 知识库管理 |
| error_book.js | 错题集UI |
| rule_config.js | 规则配置编辑器 |
| statistics.js | 统计图表 |
| model_chat.js | 对话界面 |

---

## 17. 配置文件

### 17.1 rule.json (默认规则)
```json
{
  "annotate_fields": ["chat_question", "chat_answer"],
  "answer_field": "人工标注答案",
  "result_label_field": "大模型标注答案",
  "excel_fields": ["序号", "chat_question", "chat_answer", "cot名称"]
}
```

### 17.2 settings.json (应用设置)
```json
{
  "default_model": "qwen-plus.yaml",
  "default_strategy": "方案A",
  "default_concurrency": 1
}
```

### 17.3 模型配置 (models/*.yaml)
```yaml
api_key: "sk-xxx"
base_url: "https://api.xxx.com"
model_name: "qwen-plus"
temperature: 0.7
max_tokens: 2048
```

---

## 18. 系统常量

| 常量 | 值 | 说明 |
|------|-----|------|
| MAX_TASK_CONCURRENCY | 20 | 系统最多同时运行的任务数 |
| MAX_ACTIVE_TASKS_PER_COMBO | 10 | 同一模型策略组合的最大并发数 |
| TASK_STALE_RUNNING_SECONDS | 1800 | 30分钟，超时认定为僵尸任务 |
| SYNC_INTERVAL_SECONDS | 3600 | 1小时，定时同步间隔 |
| MOCK_ANNOTATION_DELAY_SECONDS | 30 | Mock标注延迟 |

---

## 19. 关键业务流程

### 19.1 完整标注流程

```
1. 上传Excel文件
   ↓ (POST /api/excel/upload)
   创建ExcelFile记录 + 逐行ExcelRow

2. 创建标注任务
   ↓ (POST /api/workbench/annotate)
   创建AnnotationTask记录(status=pending)
   触发调度器

3. 任务调度
   ↓ (schedule_pending_annotation_tasks)
   按model_name分组，轮询分配并发槽位
   更新status=running，提交ThreadPoolExecutor

4. 并发标注
   ↓ (execute_workbench_annotation_task)
   ThreadPoolExecutor运行标注任务
   每行：
   - 提取annotate_fields数据
   - 填充Prompt模板
   - 调用strategy函数（Mock实现）
   - 解析结果，UPSERT annotation_results
   - 更新行状态

5. 结果合并
   ↓ (多Prompt时)
   对同一行的多个结果投票合并
   保存为prompt_name="__merged__"的记录

6. 统计计算
   ↓ (任务完成时)
   从annotation_results动态聚合混淆矩阵
   计算准确率、召回率等
   更新任务status=success

7. 导出结果
   ↓ (POST /api/export)
   生成4-Sheet Excel
   返回StreamingResponse供下载
```

### 19.2 追加标注流程

```
1. 工作台中选择已完成的任务
2. 选择新增行，点击"追加标注"
   ↓ (POST /api/workbench/annotate with task_id)
   解析task_id，读取既有任务配置
   更新total_rows（增量）
   合并row_data中的行ID
   重置status=running

3. 直接后台执行
   ↓ (TASK_EXECUTOR.submit())
   不走调度器排队，立即提交
   （追加模式优先级高）

4. 结果追加到existing task
   新的annotation_results记录使用相同task_id
   统计在查询时自动包含新结果
```

---

## 20. 开发指南

### 20.1 添加新标注策略

在 `strategies.py` 中：
```python
def my_strategy(prompt: str, row_data: dict, model_config_name: str, 
                prompt_list: list = None, concurrency: int = 1, 
                knowledge_list: list = None) -> dict:
    """
    返回必须包含 result_label_field 指定的字段
    """
    # 实现标注逻辑
    return {
        "大模型标注答案": "是",  # result_label_field
        "大模型标注思考": "理由...",  # 补充字段
    }

# 注册到策略表
STRATEGIES = {
    "方案A": baseline_rule,
    "方案B": strict_rule,
    "方案C": recall_rule,
    "我的方案": my_strategy,  # 新增
}
```

### 20.2 添加新模型

在 `models/` 目录创建 `my_model.yaml`：
```yaml
api_key: "sk-xxx"
base_url: "https://api.xxx.com"
model_name: "my-model"
temperature: 0.7
```

前端标注设置中会自动出现该模型。

### 20.3 接入真实模型

在 `app.py` 中修改 `MODEL_CALLERS`：
```python
def call_real_model(messages: list) -> str:
    # 调用真实API，返回回复文本
    pass

MODEL_CALLERS["my_model"] = call_real_model
```

---

## 附录：系统启动与依赖

### 环境要求
- Python 3.8+
- SQLite 3.x
- pandas, openpyxl, pyyaml, fastapi, sqlalchemy, ...

### 启动命令
```bash
cd project
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

### 默认场景初始化
系统启动时自动创建"SPN"默认场景（若不存在）

### 数据库迁移
启动时自动执行：
- 创建11张表
- 为prompts表添加role_name列（若不存在）
- 为excel_files表添加annotate_config列
- 升级annotation_tasks.current_row_id为TEXT类型
- 为annotation_results创建唯一约束

---

**文档版本**: v1.0  
**最后更新**: 2026年5月  
**作者**: AI系统

