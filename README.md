# Excel Custom Annotation Tool

这是一个用于本地调试 Excel 导入、规则驱动标注、Prompt 管理、知识管理、模型配置和统计导出的 FastAPI 小项目。项目默认使用 SQLite，本地启动后直接在浏览器里操作，适合联调自己的后台标注逻辑。

## 1. 快速开始

建议使用 Python 3.9+。

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 app.py
```

启动后访问：

```text
http://127.0.0.1:5001
```

## 2. 项目特点

- 支持 Excel 导入并全部入库
- 支持按 `rule.json` 控制列表默认显示字段、标注字段与返回字段
- 支持 Prompt 文件管理
- 支持知识库文件管理
- 支持模型配置管理
- 支持单条、选中项、全量标注
- 支持统计、导出 Excel

## 3. 目录说明

- [app.py](app.py): FastAPI 后端入口
- [strategies.py](strategies.py): 标注策略 mock 与预留 TODO
- [templates/index.html](templates/index.html): 页面模板
- [static/app.js](static/app.js): 前端交互逻辑
- [static/style.css](static/style.css): 页面样式
- [config/rule.json](config/rule.json): 规则配置
- [models](models): 模型配置目录
- [prompts](prompts): Prompt 文件目录
- [knowledge](knowledge): 知识文件目录
- [requirements.txt](requirements.txt): Python 依赖

## 4. Excel 数据说明

仓库当前没有内置示例 Excel。导入文件时，建议表头至少覆盖 [config/rule.json](config/rule.json) 中定义的字段。

当前默认配置对应的 Excel 列示例：

- `序号`
- `chat_question`
- `chat_answer`
- `api调用记录1`
- `api调用记录2`
- `api调用记录3`
- `sum合并数据`
- `人工标注答案`

字段关系：

- `excel_fields`: Excel 导入后列表默认显示的列，其他列默认隐藏，仍可在列表列选择器中手动打开
- `annotate_fields`: 参与拼接标注上下文的字段
- `answer_field`: 作为人工答案写入 `human_answer` 的列名
- `result_label_field`: 标注结果里用于判定标签的字段名

额外列可以一起导入，默认会保留在库里，只是列表里默认隐藏。

## 5. PyCharm 运行方式

1. 用 PyCharm 打开项目根目录
2. 选择 Python 3.9+ 解释器，推荐项目 venv
3. 在 Terminal 中执行 `python3 -m pip install -r requirements.txt`
4. 打开 [app.py](app.py)，右键运行或点击右上角运行按钮
5. 浏览器访问 `http://127.0.0.1:5001`

## 6. 标注逻辑接入说明

真实标注逻辑建议在 [strategies.py](strategies.py) 里实现。当前保留了 `TODO` 和 mock 逻辑，方便先联调前端。

每个策略函数都会拿到下面这些参数：

- `prompt`: 按当前数据填充并拼接后的完整 Prompt
- `prompt_list`: 所有 Prompt 文件原文列表
- `knowledge_list`: 所有知识文件原文列表
- `concurrency`: 当前组合配置的并发数
- `row_data`: 当前待标注行数据
- `model_config_name`: 当前模型配置文件名

`prompt_list` 和 `knowledge_list` 都是 `list[{"name": ..., "content": ...}]` 结构，方便直接原样透传到自己的后台。

## 7. 文件格式说明

- Prompt 管理支持：`.txt`、`.prompt`
- 知识管理支持：`.json`、`.jsonl`、`.txt`
- 模型配置支持：`.yaml`
- 数据导入支持：`.xlsx`

## 8. 数据存储说明

- 主数据库文件：`db.sqlite`
- 上传文件目录：`uploads`
- 导出结果通过页面导出按钮生成 Excel

## 9. 常见问题

### 页面打不开

确认终端里已经成功启动 `uvicorn`，然后访问：

```text
http://127.0.0.1:5001
```

### 依赖导入失败

执行：

```bash
python3 -m pip install -r requirements.txt
```

### 想接自己的后台标注接口

直接修改 [strategies.py](strategies.py) 中对应策略函数，把 `prompt_list`、`knowledge_list`、`concurrency`、`row_data`、`model_config_name` 一起传给你的接口即可。
