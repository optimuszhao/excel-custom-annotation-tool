# 数据飞轮 - AI 标注平台 PRD

## 一、产品概述

数据飞轮是一个本地化的 AI 标注质量评估平台，用于对 Excel 数据进行多模型、多策略的自动化标注，并通过混淆矩阵、准确率等指标评估标注质量。系统支持 Prompt 管理、知识库管理、规则配置、错题本等模块，所有资源按"场景"进行隔离管理。

**技术栈**：FastAPI + SQLite + Vanilla JS + Tailwind CSS

---

## 1.5 前端工程架构

> 整体页面风格和效果保持一致，但为了性能和可维护性考虑，页面不再全部写在一个 HTML 中，采用模块化拆分方案。

### 架构方案：多页面模板 + 组件化 JS

**设计原则**：
- 结构清晰：按功能模块拆分独立 HTML 模板和 JS 文件。
- 性能高效：每个页面只加载必要的 JS/CSS 资源，避免单文件过大。
- 利于维护：每个模块独立开发、独立调试，修改不影响其他模块。
- 代码规范：所有代码变量见名知意，配合良好的中文注释说明业务逻辑。

**目录结构规划**：

```
project/
├── templates/
│   ├── base.html              # 基础布局模板（导航栏、侧边菜单、公共样式引入）
│   ├── index.html             # 首页入口（Excel 数据管理列表）
│   ├── workbench.html         # 标注工作台
│   ├── task_manage.html       # 任务管理（标注工作台二级页面）
│   ├── prompt_manage.html     # Prompt 管理
│   ├── knowledge_manage.html  # 知识管理
│   ├── rule_config.html       # 规则配置
│   ├── error_book.html        # 错题集管理
│   ├── model_chat.html        # 模型对话
│   └── statistics.html        # 统计数据
├── static/
│   ├── js/
│   │   ├── common.js          # 公共工具函数（API调用、Toast通知、加载遮罩等）
│   │   ├── components.js      # 可复用UI组件（场景选择器、分页器、确认弹窗等）
│   │   ├── excel_manage.js    # Excel 数据管理逻辑
│   │   ├── workbench.js       # 标注工作台逻辑
│   │   ├── task_manage.js     # 任务管理逻辑
│   │   ├── prompt_manage.js   # Prompt 管理逻辑
│   │   ├── knowledge_manage.js# 知识管理逻辑
│   │   ├── rule_config.js     # 规则配置逻辑
│   │   ├── error_book.js      # 错题集管理逻辑
│   │   ├── model_chat.js      # 模型对话逻辑
│   │   └── statistics.js      # 统计数据逻辑
│   ├── css/
│   │   ├── tailwind.css       # Tailwind CSS 框架
│   │   └── style.css          # 自定义全局样式
│   └── img/                   # 静态图片资源
```

**实现要点**：

1. **模板继承**：所有页面继承 `base.html`，公共导航、侧边栏、样式由基础模板统一管理。
2. **按需加载**：每个页面模板只引入自身所需的 JS 文件，不加载无关模块。
3. **组件复用**：场景选择器、分页器、确认弹窗等通用 UI 抽取到 `components.js`，各页面按需调用。
4. **路由方式**：采用 FastAPI 多路由渲染不同模板，前端通过侧边菜单链接导航。
5. **状态传递**：页面间通过 URL 参数（如 `?scene=xxx&excel_id=123`）传递上下文状态。

**代码规范要求**：

- 变量命名见名知意：如 `annotationTaskList`、`currentSceneName`、`excelRowCount`。
- 函数命名语义明确：如 `loadExcelDataList()`、`submitAnnotationTask()`、`refreshLocalFile()`。
- 每个文件顶部添加模块说明注释。
- 关键业务逻辑处添加中文注释说明意图。
- CSS 类名使用 Tailwind 原子类为主，自定义类名使用 BEM 命名法。

---

## 二、功能模块

### 1. Excel 数据管理

> 系统第一个菜单项，负责 Excel 数据源的全生命周期管理。

#### 1.1 新增数据源

- 点击"新增 Excel 数据源"按钮，弹出上传窗口。
- 用户选择本地 Excel 文件上传。

#### 1.2 自动解析

上传后系统自动解析以下信息：

| 解析项 | 说明 |
|--------|------|
| 文件名 | 从上传文件中提取 |
| 总行数 | 自动统计 Excel 数据行数（不含表头） |
| 已标注数量 | 依据"规则配置"中指定的标注答案列是否有值来判定 |
| 列信息 | 自动解析 Excel 中所有列名 |

#### 1.3 表单填充

- 解析出的列信息自动填入表单。
- 支持在列表页对每一行数据进行修改。

#### 1.4 场景选择

- 弹窗中必须选择所属场景。
- 若无匹配场景，可通过封装的"场景组件"快速新增。
- 场景管理本质是维护一系列场景名称（详见模块 4）。

#### 1.5 文件存储

- 点击保存后，文件保存到项目的 `test_data/` 文件夹中。
- 若选择了特定场景，需按场景名创建子文件夹存放。
  - 示例：`test_data/场景A/xxx.xlsx`

#### 1.6 列表功能

- 支持常规查询、排序、分页。
- 提供 Excel 搜索功能（按文件名/关键词搜索）。
- 支持通过场景切换来过滤数据。

#### 1.7 列表显示列

| 列名 | 说明 |
|------|------|
| 序号 ID | 自增主键 |
| 文件名 | Excel 文件名 |
| 总行数 | 数据总行数 |
| 已标注数量 | 标注答案列有值的行数 |
| 包含的列信息 | Excel 中所有列名 |
| 所属场景 | 文件关联的场景名称 |

### 1.8 操作按钮

| 操作 | 说明 |
|------|------|
| 修改 | 修改文件名 |
| 开始标注 | 跳转至该 Excel 的"标注工作台"页面 |
| 任务创建 | 对整个 Excel 进行标注任务创建（需二次确认） |
| 更多 → 删除数据 | 删除该 Excel 数据记录 |
| 更多 → 设定默认显示列 | 设定该文件默认展示的列标记 |
| 更多 → 刷新本地文件 | 将系统中最新数据同步回本地 Excel 文件（详见 1.9） |

> **注**：系统不提供"删除全部数据"的全局清理功能。数据删除仅支持针对单条 Excel 记录的逐条操作，防止误操作导致数据丢失。

### 1.9 刷新本地文件

> 当用户在系统中修改了 Excel 的内容（如删除数据行或修改某行内容，**不包括修改列名**）后，可通过该功能将数据库中的最新数据同步回本地文件。

**单文件刷新**（列表"更多"菜单中触发）：

1. 系统先将数据库中的修改持久化保存。
2. 用户点击"刷新本地文件"后，系统删除原有本地 Excel 文件，根据数据库最新数据重新生成并保存到原路径。
3. 此操作为手动触发，不会自动执行。

**全局刷新**（页面顶部或工具栏按钮）：

- 提供"全局刷新本地 Excel 测试集"按钮。
- 点击后，系统根据数据库中所有数据集的最新数据，逐一重新生成本地 Excel 文件，确保全部本地文件与系统数据一致。
- 需二次确认，防止误操作。

---

### 2. 标注工作台

> 综合性核心操作页面，针对特定 Excel 数据进行标注作业。

#### 2.1 页面风格

- 基本业务能力也页面效果与现有项目整体风格保持一致（Tailwind CSS 主题风格）。

#### 2.2 核心功能

- 支持切换不同的 Excel 进行标注作业。
- 顶部导航栏提供：
  - 当前模型选择
  - 标注策略选择
  - 并发数配置（1-20）
  - 默认设置保存
  - 数据导出

#### 2.3 数据表格区

- 分页展示 Excel 数据行。
- 支持列宽拖拽调整。
- 支持列可见性管理。
- 支持行选择（checkbox）进行批量操作。

#### 2.4 范围选择器

- 拖动条选择数据范围（起始/结束行号）。
- 批量操作按钮：批量标注、清空标注、批量删除。

#### 2.5 Prompt 选择与标注操作

**Prompt 选择**：

- 支持手动单选或多选 Prompt。
- 选中的 Prompt 将用于本次标注任务。

**标注操作**：

| 操作方式 | 说明 |
|----------|------|
| 单条标注 | 对单行数据进行标注 |
| 批量标注 | 对选中的多行数据进行标注 |
| 全量标注 | 对整个 Excel 所有数据进行标注 |

**单 Prompt 标注流程**：

1. 用户选择一个 Prompt 并点击标注。
2. 系统将 Prompt 中的占位符进行替换（填入当前行数据）。
3. 将替换后的完整 Prompt 和行数据传递到后台。
4. 后台调用标注算法（如 Nemo 等），确保所有占位符替换完整。
5. 后台检查返回结果是否包含场景规则中定义的"模型标注答案"字段，若缺失则显示为 `UNKNOWN`。

**标注算法入参规范**：

调用后台 Mock 标注方法时，入参必须同时包含：

| 参数 | 说明 |
|------|------|
| `filled_prompt` | 已替换占位符的完整 Prompt（填入了当前行数据） |
| `prompt_list` | 当前场景下所有未替换的原始 Prompt 列表 |
| `row_data` | 当前行的标注字段数据 |
| `model_config_name` | 模型配置文件名 |
| ... | 其他参数（并发数、知识文件等） |

其中 `prompt_list` 的数据结构为：

```json
[
  {"name": "api_check", "content": "你是一个API校验专家...{question}...{api_info}..."},
  {"name": "api_label", "content": "你是一个标注专家...{question}..."},
  {"name": "final_judge", "content": "你是最终判定者...{result}..."}
]
```

- 列表中每个对象的 `name` 为 Prompt 的文件名/名称，`content` 为原始未替换的 Prompt 内容。
- 用途：传递给标注算法后，算法工程师可根据实际需要自行决定是否使用这些原始 Prompt。

**多 Prompt（多角色）标注流程**：

若用户选择了多个 Prompt，则进入多角色标注模式：

1. 系统针对该行数据，按选中的 Prompt 数量分别请求大模型（如选2个 Prompt，则请求 2 次）。
2. 自动在标注结果列前增加**角色名**（Prompt 名称），以区分不同 Prompt 的标注答案。
3. 系统对多个标注答案进行**合并判断**：
   - 若所有角色的结果均为"是"，最终答案才显示为**"是"**。
   - 若其中任何一个角色的结果为"否"，最终答案则为**"否"**。
4. 界面同时展示每个角色的独立结果和合并后的最终结果。

#### 2.6 标注结果展示

- 人工答案列展示。
- 各模型×策略组合的标注结果展示。
- 多角色标注时，分别显示各角色结果 + 合并最终结果。
- 匹配类型（TP/FN/FP/TN）标识。
- 支持按匹配类型过滤。

### 2.7 统计面板

- 核心指标卡片：已标注/总量、准确率、查全率、查准率、F1 Score。
- 混淆矩阵：TP / FN / FP / TN 四项。
- 任务状态统计：pending / running / success / failed / cancelled。

**准确率计算逻辑（UNKNOWN 排除规则）**：

- 当大模型返回报错导致没有标注答案列时，该行标记为 `UNKNOWN`。
- `UNKNOWN` 本质上属于"未标注"状态，**在计算准确率的分母中必须排除**。
- 即：`准确率 = 正确数 / (总标注数 - UNKNOWN 数)`。
- 查全率、查准率、F1 Score 的计算同样排除 UNKNOWN 数据。

### 2.8 任务管理（实时状态）

- 任务状态实时轮询（2 秒间隔）。
- 支持取消单个/批量任务。
- 超时任务自动恢复机制。

#### 2.9 标注任务管理（二级页面）

> 通过任务表跟踪并显示多次标注的结果，解决同一场景、同一数据多次标注结果覆盖的问题。

**入口设计**：

- 无需在左侧菜单新增入口。
- 在"标注工作台"中，用户选择场景和 Excel 数据后，提供一个显眼的**"标注任务"按钮**。
- 点击后跳转至二级任务管理页面（`task_manage.html`）。

**页面内容**：

- 清晰列出针对当前 Excel 的**历次标注任务**。
- 每条任务记录包含：

| 字段 | 说明 |
|------|------|
| 任务 ID | 任务唯一标识 |
| 创建时间 | 任务创建的时间戳 |
| 使用模型 | 本次标注使用的模型名称 |
| 使用策略 | 本次标注使用的策略名称 |
| 标注数据行数 | 本次任务涉及的数据总行数 |
| 成功数 | 标注成功的行数 |
| 失败数 | 标注失败的行数（含 UNKNOWN） |
| 准确率 | 本次任务的标注准确率（排除 UNKNOWN） |
| 查全率 | 本次任务的查全率 |
| 查准率 | 本次任务的查准率 |
| F1 Score | 本次任务的 F1 值 |
| 任务状态 | pending / running / success / failed / cancelled |

**默认显示逻辑**：

- 标注工作台主页面**默认显示最近一次任务的结果**。
- 通过进入任务管理界面，用户可以查看并**切换历史任务的结果与详细指标**。
- 切换任务后，标注工作台的数据表格和统计面板同步更新为对应任务的结果。

**操作按钮**：

- 查看详情：展开该任务的逐行标注结果。
- 对比：支持选择两个任务进行指标对比。
- 删除：删除历史任务记录（需二次确认）。

#### 2.10 数据导出

- 导出 4-sheet Excel 文件：
  - Sheet 1：标注数据
  - Sheet 2：统计数据
  - Sheet 3：标注明细
  - Sheet 4：导出信息

---

### 3. Prompt 管理、知识管理与错题集管理

> 对 Prompt 进行增删改查，按场景隔离管理。Prompt 管理描述需保持详尽。

#### 3.1 内容维护

- 维护 Prompt 名称（角色）和具体内容。
- 支持 `.prompt` 和 `.txt` 格式文件。
- 文件列表 + 编辑区域的双栏布局。
- 每个场景下独立维护一系列 Prompt 文件。

#### 3.2 规则检查

- 新增 Prompt 时需提供友好提示，引导用户进行规则检查。
- 检查内容：Prompt 模板中是否包含必要的变量占位符。

#### 3.3 联动逻辑

- Prompt 内容**必须包含**"规则配置"中指定的标注列名称。
- 若 Prompt 中缺少标注列字段，系统应给出警告提示，提醒用户无法正确计算准确率。

#### 3.4 模板语法

- 使用 Python `format` 语法进行变量填充：`{字段名}`。
- 变量来源为 `rule.json` 中 `annotate_fields` 配置的字段。

---

### 3.5 知识管理

> 对知识库文件进行增删改查，按场景隔离管理。知识管理描述需保持详尽。

- 支持 `.json`、`.jsonl`、`.txt` 格式文件。
- 每个场景下独立维护一系列知识库文件。
- 文件列表 + 编辑区域的双栏布局。
- 知识文件可在标注时传递给策略函数，作为上下文补充信息。

---

### 3.6 错题集管理

> 按场景隔离，记录标注过程中的错误案例，便于复盘和优化。

#### 结构层级

```
场景 → 测试数据集 (Excel) → COT 名称 → 错题集列表
```

#### 功能说明

- **COT 名称分类**：错题集支持根据 COT（Chain of Thought）名称进行分类管理。
- **自动读取 COT**：系统在导入数据集时，自动读取并存储其中的 COT 名称字段。
- **创建错题**：创建错题记录时，必须选择对应的 COT 分类。
- **数据隔离**：不同场景、不同数据集、不同 COT 下各自维护独立的错题列表。

#### 错题记录内容

| 字段 | 说明 |
|------|------|
| 所属场景 | 错题归属的场景 |
| 数据集来源 | 来自哪个 Excel 文件 |
| COT 名称 | 错题所属的 COT 分类 |
| 原始数据 | 标注时的输入数据 |
| 期望答案 | 人工标注的正确答案 |
| 实际输出 | 大模型标注的错误答案 |
| 错误原因 | 可选，人工备注分析 |

---

### 4. 场景化管理架构

> 规则管理、Prompt 管理、知识管理和错题本管理四大模块，必须严格按照"场景"进行划分。

#### 4.1 导航设计

- 页面左侧（或顶部）需提供**竖向平铺**的场景管理菜单。
- 方便用户快速点选切换不同场景。
- 切换场景后，右侧内容区域自动加载对应场景的数据。

#### 4.2 快捷新增

- 在场景切换菜单的最下方设置"新增"按钮。
- 支持全局快速新增场景。
- 新增场景后自动切换到新场景。

#### 4.3 数据隔离

不同场景下维护各自独立的：

| 模块 | 存储方式 |
|------|----------|
| Prompt 文件 | `prompts/{场景名}/` 目录 |
| 知识库文件 | `knowledge/{场景名}/` 目录 |
| 错题本数据 | 按场景隔离存储 |
| 规则配置 | 每个场景对应独立的规则配置 |

#### 4.4 场景管理

- 场景本质是一系列名称的列表维护。
- 支持新增、重命名、删除场景。
- 删除场景需二次确认，提示关联数据将一并清理。

---

### 5. 规则配置

> 每个场景对应一个规则配置，定义标注与评估的核心字段映射。

#### 5.1 核心配置项

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `annotate_fields` | 参与标注上下文的字段列表 | `["chat_question", "api_info"]` |
| `answer_field` | 人工答案字段（哪一列是"人工答案"） | `"人工标注答案"` |
| `result_label_field` | 标注列答案（哪一列是"标注列答案"） | `"大模型标注答案"` |
| `excel_fields` | 列表默认显示的字段 | `["序号", "chat_question", ...]` |

#### 5.2 字段说明

- **标注列答案**（`result_label_field`）：大模型标注产生的结果字段名，用于与人工答案对比计算指标。
- **人工答案**（`answer_field`）：Excel 中人工标注的正确答案列名，作为评估基准。

#### 5.3 配置联动

- 规则配置变更后，影响：
  - 已标注数量的计算逻辑。
  - 统计指标的对比基准。
  - Prompt 模板的变量校验。

---

## 三、标注算法与模型调用

### 3.1 标注算法（Mock 阶段）

> 当前标注算法全部采用后台 Mock 处理，具体算法逻辑由算法工程师后续实现。

- **响应时间**：Mock 响应控制在 **2 秒左右**，模拟真实调用延迟。
- **Mock 结果**：返回预设的标注结果字典，方便前端功能测试。
- **扩展预留**：策略函数内部留有 TODO 注释，标明算法工程师接入真实模型的位置。

### 3.2 标注策略插件化

- 所有标注策略定义在 `strategies.py` 中。
- 通过 `STRATEGIES` 字典注册，无需修改主程序即可新增策略。
- 策略命名格式：`方案A`、`方案B`、`方案C`。

### 3.3 策略函数签名

```python
def strategy_name(
    prompt: str,              # 拼接后的完整 Prompt（已填入数据）
    row_data: dict,           # 标注字段数据
    model_config_name: str,   # 模型配置文件名
    prompt_list: list,        # Prompt 文件列表
    concurrency: int,         # 并发数
    knowledge_list: list      # 知识文件列表
) -> dict:
    # 返回结果必须包含 result_label_field 对应的字段
```

### 3.4 模型×策略组合

- 组合名格式：`{模型名}({策略名})`，如 `qwen-plus(方案A)`。
- 支持多维度对比：同一数据在不同模型、不同策略下的标注效果。

### 3.5 模型调用能力（预留）

> 在标注策略同级位置，新增模型调用的独立 function，当前 Mock 返回，后续由算法工程师实现真实调用。

**实现方式**：

- 在对应的 `.py` 文件中，预留 2-3 个调用大模型的方法入口。
- 当前全部 Mock 返回固定结果，模拟调用延迟约 2 秒。
- 采用字典形式注册：`MODEL_CALLERS = {"模型名称": function}`。
- 后续算法工程师只需替换 function 实现即可接入真实大模型。

```python
# 示例：模型调用注册表
MODEL_CALLERS = {
    "qwen-plus": call_qwen_plus,
    "deepseek-chat": call_deepseek_chat,
    "gpt-4.1-mini": call_gpt4_mini,
}
```

---

## 四、并发控制

| 参数 | 值 | 说明 |
|------|-----|------|
| 全局最大并发 | 20 | 所有任务的总并发上限 |
| 单组合最大活跃任务 | 10 | 单个模型×策略组合的活跃任务上限 |
| 前端配置范围 | 1-20 | 用户可配置的并发数范围 |

---

## 五、数据模型

### 5.1 数据库表设计

#### 表 1：`scenes`（场景表）

> 维护系统中所有场景名称，作为全局场景管理的数据源。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 场景唯一标识 |
| name | VARCHAR(100) | UNIQUE, NOT NULL | 场景名称 |
| description | TEXT | 可空 | 场景描述 |
| created_at | DATETIME | NOT NULL, 默认当前时间 | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

---

#### 表 2：`excel_files`（Excel 文件表）

> 记录导入的 Excel 文件元信息，一个文件对应一条记录。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 文件唯一标识 |
| file_name | VARCHAR(255) | NOT NULL | 文件名（可修改） |
| original_file_name | VARCHAR(255) | NOT NULL | 原始上传文件名 |
| scene_id | INTEGER | FK → scenes.id, NOT NULL | 所属场景 |
| total_rows | INTEGER | NOT NULL, 默认0 | 总行数 |
| annotated_count | INTEGER | NOT NULL, 默认0 | 已标注数量 |
| columns_info | JSON | NOT NULL | 列信息（所有列名列表） |
| display_columns | JSON | 可空 | 默认显示列配置 |
| file_path | VARCHAR(500) | NOT NULL | 本地文件存储路径 |
| cot_names | JSON | 可空 | 自动解析出的 COT 名称列表 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

---

#### 表 3：`excel_rows`（Excel 数据行表）

> 存储导入的 Excel 每行数据，每行对应原始 Excel 中的一行。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 行唯一标识 |
| file_id | INTEGER | FK → excel_files.id, NOT NULL | 所属文件 |
| row_index | INTEGER | NOT NULL | 行号（从1开始） |
| data | JSON | NOT NULL | 行数据（字段名:value 的字典） |
| human_answer | VARCHAR(500) | 可空 | 人工标注答案（从 data 中提取） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引**：`(file_id, row_index)` 联合索引

---

#### 表 4：`annotation_tasks`（标注任务表）

> 记录每次标注任务的元信息和统计结果，支持多次标注历史追溯。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK, UUID | 任务唯一标识 |
| file_id | INTEGER | FK → excel_files.id, NOT NULL | 所属文件 |
| scene_id | INTEGER | FK → scenes.id, NOT NULL | 所属场景 |
| model_name | VARCHAR(100) | NOT NULL | 模型×策略组合名（如 "qwen-plus(方案A)"） |
| model_config | VARCHAR(100) | NOT NULL | 模型配置文件名 |
| strategy | VARCHAR(50) | NOT NULL | 策略名称 |
| prompt_names | JSON | NOT NULL | 本次使用的 Prompt 名称列表 |
| concurrency | INTEGER | NOT NULL, 默认1 | 并发数 |
| total_rows | INTEGER | NOT NULL, 默认0 | 本次任务涉及的数据行数 |
| success_count | INTEGER | NOT NULL, 默认0 | 成功数 |
| failed_count | INTEGER | NOT NULL, 默认0 | 失败数（含 UNKNOWN） |
| accuracy | FLOAT | 可空 | 准确率（排除 UNKNOWN） |
| recall | FLOAT | 可空 | 查全率 |
| precision | FLOAT | 可空 | 查准率 |
| f1_score | FLOAT | 可空 | F1 分数 |
| status | VARCHAR(20) | NOT NULL, 默认'pending' | 任务状态（pending/running/success/failed/cancelled） |
| error | TEXT | 可空 | 错误信息 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| started_at | DATETIME | 可空 | 开始执行时间 |
| finished_at | DATETIME | 可空 | 完成时间 |

**索引**：`(file_id, created_at)` 联合索引，用于查询某文件的历史任务

---

#### 表 5：`annotation_results`（标注结果表）

> 存储每条数据行的标注结果，与任务和行关联。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 结果唯一标识 |
| task_id | VARCHAR(36) | FK → annotation_tasks.id, NOT NULL | 所属任务 |
| row_id | INTEGER | FK → excel_rows.id, NOT NULL | 所属数据行 |
| model_name | VARCHAR(100) | NOT NULL | 模型×策略组合名 |
| prompt_name | VARCHAR(100) | 可空 | 使用的 Prompt 名称（多角色时区分） |
| prompt_version | VARCHAR(100) | 可空 | Prompt 版本号（hash 或文件名列表） |
| result | JSON | 可空 | 标注结果字典（全部返回字段） |
| label | VARCHAR(200) | 可空 | 标注标签（从 result 中提取的 result_label_field） |
| merged_label | VARCHAR(200) | 可空 | 多角色合并后的最终标签 |
| match_type | VARCHAR(20) | 可空 | 匹配类型（TP/FN/FP/TN/UNKNOWN） |
| duration_ms | INTEGER | 可空 | 标注耗时（毫秒） |
| error | TEXT | 可空 | 错误信息（失败时） |
| created_at | DATETIME | NOT NULL | 创建时间 |

**索引**：
- `(task_id, row_id)` 联合索引
- `(row_id, model_name)` 联合索引，用于查询某行在某模型下的所有标注结果

---

#### 表 6：`prompts`（Prompt 表）

> 存储各场景下维护的 Prompt 文件内容。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | Prompt 唯一标识 |
| scene_id | INTEGER | FK → scenes.id, NOT NULL | 所属场景 |
| name | VARCHAR(100) | NOT NULL | Prompt 名称（角色名） |
| content | TEXT | NOT NULL | Prompt 内容（含占位符） |
| file_type | VARCHAR(20) | NOT NULL, 默认'.prompt' | 文件格式（.prompt / .txt） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引**：`(scene_id, name)` 联合唯一索引

---

#### 表 7：`knowledge_files`（知识库表）

> 存储各场景下的知识库文件。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 知识文件唯一标识 |
| scene_id | INTEGER | FK → scenes.id, NOT NULL | 所属场景 |
| name | VARCHAR(100) | NOT NULL | 文件名称 |
| content | TEXT | NOT NULL | 文件内容 |
| file_type | VARCHAR(20) | NOT NULL | 文件格式（.json / .jsonl / .txt） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引**：`(scene_id, name)` 联合唯一索引

---

#### 表 8：`rule_configs`（规则配置表）

> 每个场景对应一条规则配置。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 规则唯一标识 |
| scene_id | INTEGER | FK → scenes.id, UNIQUE, NOT NULL | 所属场景（一对一） |
| annotate_fields | JSON | NOT NULL | 参与标注上下文的字段列表 |
| answer_field | VARCHAR(100) | NOT NULL | 人工答案字段名 |
| result_label_field | VARCHAR(100) | NOT NULL | 标注结果字段名（大模型标注答案） |
| excel_fields | JSON | 可空 | 列表默认显示的字段 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

---

#### 表 9：`error_books`（错题集表）

> 存储标注过程中的错误案例，按场景、数据集、COT 分类管理。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 错题唯一标识 |
| scene_id | INTEGER | FK → scenes.id, NOT NULL | 所属场景 |
| file_id | INTEGER | FK → excel_files.id, NOT NULL | 来源数据集 |
| cot_name | VARCHAR(100) | NOT NULL | COT 分类名称 |
| row_id | INTEGER | FK → excel_rows.id, 可空 | 关联的原始数据行 |
| original_data | JSON | NOT NULL | 原始输入数据 |
| expected_answer | VARCHAR(500) | NOT NULL | 期望答案（人工标注） |
| actual_output | VARCHAR(500) | NOT NULL | 实际输出（大模型标注） |
| error_reason | TEXT | 可空 | 错误原因分析（人工备注） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引**：`(scene_id, file_id, cot_name)` 联合索引

---

#### 表 10：`chat_sessions`（对话会话表）

> 模型对话功能的会话管理。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | VARCHAR(36) | PK, UUID | 会话唯一标识 |
| model_name | VARCHAR(100) | NOT NULL | 使用的模型名称 |
| title | VARCHAR(200) | 可空 | 会话标题（取首次消息摘要） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 最后活跃时间 |

---

#### 表 11：`chat_messages`（对话消息表）

> 存储模型对话的每条消息。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INTEGER | PK, 自增 | 消息唯一标识 |
| session_id | VARCHAR(36) | FK → chat_sessions.id, NOT NULL | 所属会话 |
| role | VARCHAR(20) | NOT NULL | 角色（user / assistant） |
| content | TEXT | NOT NULL | 消息内容 |
| created_at | DATETIME | NOT NULL | 发送时间 |

**索引**：`(session_id, created_at)` 联合索引

---

### 5.2 表关系图（ER）

```
scenes (1) ────┬──── (N) excel_files
  │              │
  │              └──── (N) excel_rows
  │                          │
  ├──── (N) prompts            │
  │                          │
  ├──── (N) knowledge_files   │
  │                          │
  ├──── (1) rule_configs      │
  │                          │
  ├──── (N) error_books       │
  │                          │
  └──── (N) annotation_tasks  │
                   │          │
                   └── (N) annotation_results
                               │
                               └── excel_rows (N:1)

chat_sessions (1) ──── (N) chat_messages
```

### 5.3 核心关系说明

| 关系 | 类型 | 说明 |
|------|------|------|
| scenes → excel_files | 1:N | 一个场景下可有多个数据集 |
| excel_files → excel_rows | 1:N | 一个文件含多行数据 |
| scenes → prompts | 1:N | 一个场景下有多个 Prompt |
| scenes → knowledge_files | 1:N | 一个场景下有多个知识文件 |
| scenes → rule_configs | 1:1 | 每个场景对应一份规则配置 |
| scenes → error_books | 1:N | 一个场景下有多条错题记录 |
| scenes → annotation_tasks | 1:N | 一个场景下有多次标注任务 |
| annotation_tasks → annotation_results | 1:N | 一次任务产生多条标注结果 |
| excel_rows → annotation_results | 1:N | 一行数据可被多次标注 |
| excel_files → error_books | 1:N | 错题记录关联来源数据集 |
| chat_sessions → chat_messages | 1:N | 一个会话含多条消息 |

### 5.4 设计说明

1. **场景为核心数据隔离轴**：几乎所有业务表都通过 `scene_id` 关联场景，实现数据隔离。
2. **任务可追溯**：`annotation_tasks` 保留每次标注的完整元信息，支持历史任务对比。
3. **多角色标注支持**：`annotation_results` 通过 `prompt_name` 字段区分不同角色的结果，`merged_label` 存储合并判断结果。
4. **灵活的 JSON 字段**：`data`、`result`、`columns_info` 等采用 JSON 类型，适应不同 Excel 的列结构差异。
5. **软删除策略**：暂不实现软删除，删除操作通过前端二次确认保护；后续可增加 `is_deleted` 字段。
6. **时间戳规范**：所有表均包含 `created_at`，有修改场景的表增加 `updated_at`。

## 文件存储结构

```
project/
├── data/                       # 持久化存储根目录
│   ├── datasets/               # 导入与导出的 Excel 数据集
│   │   ├── 场景A/
│   │   │   └── data1.xlsx
│   │   └── 场景B/
│   │       └── data2.xlsx
│   ├── prompts/                # Prompt 文件（按场景分子目录）
│   │   ├── 场景A/
│   │   └── 场景B/
│   ├── knowledge/              # 知识库文件（按场景分子目录）
│   │   ├── 场景A/
│   │   └── 场景B/
│   ├── rules/                  # 规则配置（按场景分文件）
│   │   ├── 场景A.json
│   │   └── 场景B.json
│   ├── error_books/            # 错题本文件（按场景分子目录）
│   │   ├── 场景A/
│   │   └── 场景B/
│   └── exports/                # 导出文件暂存目录
├── models/                     # 模型配置（全局共享，保留原有）
├── config/
│   └── settings.json           # 全局默认配置
└── db.sqlite                   # SQLite 数据库
```

---

## 5.5 数据落盘与文件管理

> 规划专门的存储目录用于持久化落盘，确保线上数据与本地文件双向同步。

#### 目录规划

所有持久化数据统一存储在 `project/data/` 目录下，分别存储：

| 子目录 | 内容 | 说明 |
|--------|------|------|
| `data/datasets/` | 导入与导出的 Excel 数据集 | 按场景分子目录 |
| `data/prompts/` | 前台维护的 Prompt 文件 | 按场景分子目录 |
| `data/knowledge/` | 前台维护的知识文件 | 按场景分子目录 |
| `data/rules/` | 规则配置 JSON | 每个场景一个文件 |
| `data/error_books/` | 错题本文件 | 按场景分子目录 |
| `data/exports/` | 导出文件暂存 | 定期清理 |
| `models/` | 模型配置文件 | 全局共享，保留原有位置 |

#### 同步机制

在 Prompt、知识、错题本、规则等管理页面，均提供**"同步到本地文件"**按钮：

- 点击后，将在工具运行期间在线编辑的内容同步刷新到本地 `data/` 对应目录下。
- 同步方式：以数据库中的最新数据为准，覆盖写入本地文件。
- 同步范围：当前场景下的所有相关文件。
- 操作为手动触发，需确认提示。

#### 启动加载逻辑

项目启动时（`app.py` 初始化阶段），系统自动执行：

1. 扫描 `data/` 目录下的所有文件。
2. 解析并入库：将本地文件数据读入数据库，确保线上数据与本地文件一致。
3. 冲突处理：若数据库已有数据且与本地文件不一致，以本地文件为准（本地文件视为权威源）。
4. 新增检测：若本地有新文件未入库，自动导入。
5. 删除检测：若本地文件已删除但数据库仍有记录，标记为已移除（不自动删除数据库数据，防误操作）。

--

## 六、模型对话

> 新增"模型对话"菜单，实现类似 ChatGPT 的对话窗口功能。

### 6.1 功能描述

- 提供对话式交互界面，用户可与大模型进行多轮对话。
- 支持选择不同模型进行对话。
- 界面风格类似 ChatGPT：消息气泡、输入框、发送按钮。

### 6.2 模型选择

- 对话框顶部提供模型选择下拉框。
- 可选模型来自 `models/` 目录下的配置文件。
- 选择模型后，后台调用对应的 function 返回结果。

### 6.3 调用逻辑

- 前端配置通过字典形式匹配：KEY 为模型名称，VALUE 为对应的 function。
- 用户选择模型名称 → 输入消息 → 后台匹配对应 function → 返回结果。
- 当前阶段为 Mock 返回（延迟约 2 秒），后续由算法工程师替换为真实调用。

### 6.4 对话记录

- 支持多轮对话上下文保持。
- 对话记录在会话期间保留，页面刷新后可选择是否持久化。

---

## 6.5 通用表格规范

> 适用于系统中所有列表/表格页面的统一规范。

| 规范项 | 说明 |
|--------|------|
| 分页 | 所有表格均具备分页功能，默认每页显示 **20 条**数据 |
| 搜索 | 支持按不同列进行搜索过滤 |
| 排序 | 支持按不同列进行升序/降序排序 |
| 更多菜单 | 每个表格右侧的"更多"菜单中包含"查看详情"选项 |
| 详情显示 | "查看详情"的展示方式参考当前标注工作台的模式（右侧滑出面板或弹窗展示完整信息） |
| 空状态 | 无数据时显示友好的空状态提示 |
| 加载状态 | 数据加载时显示加载动画/骨架屏 |

---

## 七、非功能需求

| 项目 | 要求 |
|------|------|
| 部署方式 | 本地部署，单机运行 |
| 浏览器支持 | Chrome / Edge 最新版 |
| 数据安全 | 路径遍历防护、删除前冲突检查 |
| 性能 | 支持万级行数据标注、任务并发控制防过载；页面模块化拆分避免单文件过大 |
| 可扩展性 | 策略插件化、Prompt 模板化、配置驱动 |
| 可维护性 | 多模板拆分、JS 模块化、变量见名知意、良好的中文注释 |
| 代码规范 | 函数/变量语义化命名、模块顶部说明注释、关键逻辑行内注释 |

---

## 八、页面导航结构

```
┌─────────────────────────────────────────────────┐
│  顶部导航栏：模型选择 | 策略选择 | 并发数 | 导出  │
│  [全局刷新本地 Excel 测试集]                       │
├──────────┬──────────────────────────────────────┤
│ 侧边菜单  │                                      │
│          │                                      │
│ ● Excel  │         主内容区域                     │
│   数据管理│                                      │
│          │  根据菜单切换显示：                     │
│ ● 标注   │  - Excel列表/标注工作台               │
│   工作台  │  - Prompt 编辑器                     │
│          │  - 知识库编辑器                       │
│ ● Prompt │  - 模型配置                          │
│   管理    │  - 规则配置                          │
│          │  - 统计面板                           │
│ ● 知识   │  - 错题本                            │
│   管理    │  - 模型对话                          │
│          │                                      │
│ ● 规则   │                                      │
│   配置    │                                      │
│          │                                      │
│ ● 错题本 │                                      │
│          │                                      │
│ ● 模型   │                                      │
│   对话    │                                      │
│          │                                      │
│ ● 统计   │                                      │
│   数据    │                                      │
└──────────┴──────────────────────────────────────┘
```

> **注**：Prompt 管理、知识管理、规则配置、错题本四个模块内部均带有场景切换导航（左侧竖向平铺场景列表）。

---

## 九、术语表

| 术语 | 说明 |
|------|------|
| COT | Chain of Thought，思维链，指大模型推理过程的名称分类 |
| Mock | 模拟实现，当前阶段用预设数据代替真实大模型调用 |
| UNKNOWN | 标注失败状态，大模型报错导致无有效标注结果 |
| TP/FN/FP/TN | 混淆矩阵四项：真正例/假负例/假正例/真负例 |
| 策略 | 标注方案，定义具体的 Prompt 组合和调用逻辑 |
