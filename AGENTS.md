# AGENTS.md

本文件是 `/Users/zhaotianqiang/Documents/01-coding/AI/数据飞轮/project` 的项目级协作规则。所有自动化编码助手在本项目内工作时优先遵守这些规则。

## 项目定位

这是一个本地运行的 FastAPI 标注调试台，用于 Excel 导入、规则驱动标注、Prompt 管理、知识管理、模型配置、任务调度、统计和导出。

核心文件：

- `app.py`: FastAPI 后端入口、SQLite ORM、任务调度、导入导出、管理接口。
- `strategies.py`: 标注策略插件入口，真实后台标注逻辑优先接在这里。
- `templates/index.html`: 单页工作台模板。
- `static/app.js`: 前端状态、接口调用、表格交互、批量标注、管理页逻辑。
- `static/style.css`: 项目自定义样式。
- `config/rule.json`: Excel 字段、标注字段、人工答案字段、模型结果字段配置。
- `config/settings.json`: 默认模型、默认策略、默认并发配置。
- `models/*.yaml`: 模型配置文件。
- `prompts/*.prompt`、`prompts/*.txt`: Prompt 文件。
- `knowledge/*.json`、`knowledge/*.jsonl`、`knowledge/*.txt`: 知识文件。
- `db.sqlite`: 主 SQLite 数据库。
- `uploads/`: 上传文件目录。
- `lib/`、`lib/wheels/`: 本地依赖与离线 wheel。

## 命令规则

- 终端命令统一加 `rtk` 前缀。
- 复杂命令可用 `rtk proxy <cmd>` 执行。
- 常用启动命令：`rtk python3 app.py`。
- 本地访问地址：`http://127.0.0.1:5001`。
- 离线安装依赖：`rtk python3 -m pip install --no-index --find-links=lib/wheels -r requirements.txt`。
- 重建本地依赖目录：`rtk python3 -m pip install --no-index --find-links=lib/wheels --target lib -r requirements.txt`。

## 代码边界

- 后端逻辑优先放在 `app.py`，标注策略优先放在 `strategies.py`。
- 新增标注方案时，在 `strategies.py` 新增函数，并把显示名注册到 `STRATEGIES`。
- 策略函数签名保持兼容：`prompt, row_data, model_config_name, prompt_list=None, concurrency=1, knowledge_list=None`。
- 策略返回值需要包含 `config/rule.json` 的 `result_label_field` 对应字段，当前默认是 `大模型标注答案`。
- 读写 Prompt、知识、模型配置文件时复用现有安全路径函数：`safe_prompt_path`、`safe_knowledge_path`、`safe_model_path`。
- 前端 API 调用统一走 `static/app.js` 的 `api()`，提示统一用 `showToast()`。
- 数据表格、批量标注、任务轮询相关状态统一挂在 `state`。

## 数据与文件

- `db.sqlite`、`data.db`、`uploads/` 属于本地运行数据，编辑前确认任务目标。
- `lib/` 是本地三方依赖目录，业务修改集中在项目代码、配置、Prompt、知识文件。
- `config/rule.json` 控制导入字段和标注字段，字段名改动会影响导入、展示、统计和导出。
- Excel 导入支持 `.xlsx`，页面文件选择也接受 `.xls`、`.csv`，后端读取逻辑以当前 `app.py` 为准。
- Prompt 支持 `.txt`、`.prompt`；知识支持 `.json`、`.jsonl`、`.txt`；模型配置支持 `.yaml`。

## 并发与任务

- 标注任务通过 `annotation_tasks` 表持久化，调度器会恢复 pending、stale running 和孤儿任务。
- 全局最大并发由 `MAX_TASK_CONCURRENCY` 控制，当前是 `20`。
- 单组合活跃任务上限由 `MAX_ACTIVE_TASKS_PER_COMBO` 控制，当前是 `10`。
- 前端并发输入范围是 `1` 到 `20`，后端通过 `clamp_task_concurrency()` 收敛。
- 修改任务调度、取消、恢复逻辑时同步检查接口 `/api/annotation-tasks*` 与前端轮询逻辑。

## 后端约定

- 使用 SQLAlchemy ORM 和现有 `SessionLocal`。
- SQLite 连接保持 `check_same_thread=False`，线程任务中创建独立 session。
- 统计指标沿用 TP、FN、FP、TN 与 `calc_match_type()`。
- 二分类标签归一化沿用 `normalize_binary_label()`，中文主标签是 `是`、`否`。
- 导出逻辑通过 `/api/export` 生成 Excel 流，字段来源来自数据库数据、规则配置和标注结果。

## 前端约定

- 页面是单页工作台，入口在 `templates/index.html`，交互集中在 `static/app.js`。
- 维持当前密集型工具界面风格，优先提升操作效率、反馈清晰度和表格可读性。
- 新增控件时保持现有 Tailwind 类与 `static/style.css` 的组合方式。
- 新增页面区域时接入 `switchPage()` 和侧边栏现有结构。
- 复制、导入、导出、批量操作需要明确 toast 或状态条反馈。

## 验证流程

- 后端改动后运行：`rtk python3 -m py_compile app.py strategies.py`。
- 涉及启动链路时运行：`rtk python3 app.py`，确认服务监听 `127.0.0.1:5001`。
- 涉及前端交互时在浏览器访问 `http://127.0.0.1:5001`，检查控制台和主要工作流。
- 涉及导入导出时使用 `uploads/test_data.xlsx` 或用户指定样例验证。
- 涉及任务调度时验证单条标注、选中标注、全量标注、取消 pending、统计刷新。

## 协作风格

- 回答直接给结论，再给必要依据。
- 中文优先，术语沿用项目内表达。
- 概念解释控制在 3 到 5 句。
- 比较方案时给推荐方案，并说明关键理由。
- 代码改动保持小范围，优先贴合现有结构。
- 修改本地运行数据、数据库文件、上传文件前说明影响范围。
- 发现用户已有改动时保留并顺着现状继续。

最终建议：这个项目的主扩展点是 `strategies.py`，主稳定性风险在任务调度、SQLite 并发和前端批量状态同步，改动时优先围绕这三处做验证。
