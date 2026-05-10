# Excel Custom Annotation Tool

这是一个用于本地调试 Excel 导入、规则驱动标注、Prompt 管理、知识管理、模型配置和统计导出的 FastAPI 小项目。项目默认使用 SQLite，本地启动后直接在浏览器里操作，适合联调你自己的后台标注逻辑。

## 1. 快速开始

直接运行：

```bash
python3 app.py
```

启动后访问：

```text
http://127.0.0.1:5001
```

项目会优先加载根目录下的 `lib`，当前仓库已经包含可运行依赖，适合离线环境直接启动。

## 2. 项目特点

- 支持 Excel 导入并全部入库
- 支持按 `rule.json` 控制列表默认显示字段、标注字段与返回字段
- 支持 Prompt 文件管理
- 支持知识库文件管理
- 支持模型配置管理
- 支持单条、选中项、全量标注
- 支持统计、导出 Excel
- 支持本地 `lib` 依赖优先加载

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
- `lib`: 本地可运行依赖目录
- `lib/wheels`: 离线 pip 安装包目录

## 4. Excel 数据说明

仓库当前没有内置示例 Excel。导入文件时，建议表头至少覆盖你在 [config/rule.json](config/rule.json) 中定义的字段。

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

- `excel_fields`: 列表默认显示这些列
- `annotate_fields`: 标注时会把这些列拼进上下文
- `answer_field`: 这列会写入人工答案
- `result_label_field`: 模型返回结果里用这列做最终标签判断

额外列可以一起导入，默认会保留在库里，只是列表里默认隐藏。

## 5. 推荐启动方式

### 方式 A：用 PyCharm 打开工程，最省心

这个项目已经改成会优先加载项目根目录下的 `lib`。只要 `lib` 存在并且内容完整，哪怕当前 Python 环境没有安装这些三方包，也可以直接启动。

推荐直接用 PyCharm 打开工程根目录并运行 [app.py](app.py)。

PyCharm 操作步骤：

1. `Open` 当前工程根目录
2. 解释器选择 Python 3.9，推荐项目 venv 或本机 Python 3.9
3. 打开 [app.py](app.py) 后直接点击运行
4. 浏览器访问 `http://127.0.0.1:5001`

如果你更习惯终端，也可以直接执行：

```bash
python3 app.py
```

启动后访问：

```text
http://127.0.0.1:5001
```

### 方式 B：从本地 wheel 离线安装

如果你希望把依赖安装到当前虚拟环境，而不是直接依赖项目里的 `lib`，使用下面的命令：

```bash
python3 -m pip install --no-index --find-links=lib/wheels -r requirements.txt
```

### 方式 C：重新安装到项目本地 lib

如果你想重建项目自己的本地依赖目录：

```bash
python3 -m pip install --no-index --find-links=lib/wheels --target lib -r requirements.txt
```

## 6. PyCharm 运行方式

1. 用 PyCharm 打开项目根目录
2. 选择一个 Python 3.9 解释器，推荐 venv 或系统 Python 3.9
3. 在 `Project` 视图中打开 [app.py](app.py)
4. 右键 `Run 'app'` 或点击右上角运行按钮
5. 打开浏览器访问 `http://127.0.0.1:5001`
6. 如果 PyCharm 弹出解释器缺失提示，直接选择现有解释器或新建一个 venv 即可

因为 [app.py](app.py) 已经会自动把 `lib` 加到 `sys.path` 最前面，所以一般不需要再手动配 `PYTHONPATH`。

## 7. 首次下载后的建议步骤

PyCharm 用户建议顺序：

1. 用 PyCharm 打开工程
2. 选好 Python 解释器
3. 如果你希望把依赖装进当前解释器，执行：

```bash
python3 -m pip install --no-index --find-links=lib/wheels -r requirements.txt
```

4. 直接运行 [app.py](app.py)

如果你当前机器完全离线，且不想往解释器安装任何包，也可以直接：

```bash
python3 app.py
```

## 8. 标注逻辑接入说明

真实标注逻辑建议在 [strategies.py](strategies.py) 里实现。当前保留了 `TODO` 和 mock 逻辑，方便先联调前端。

每个策略函数都会拿到下面这些参数：

- `prompt`: 按当前数据填充并拼接后的完整 Prompt
- `prompt_list`: 所有 Prompt 文件原文列表
- `knowledge_list`: 所有知识文件原文列表
- `concurrency`: 当前组合配置的并发数
- `row_data`: 当前待标注行数据
- `model_config_name`: 当前模型配置文件名

`prompt_list` 和 `knowledge_list` 都是 `list[{"name": ..., "content": ...}]` 结构，方便你直接原样透传到自己的后台。

## 9. 文件格式说明

- Prompt 管理支持：`.txt`、`.prompt`
- 知识管理支持：`.json`、`.jsonl`、`.txt`
- 模型配置支持：`.yaml`
- 数据导入支持：`.xlsx`

### `config/rule.json` 字段用途

- `excel_fields`: Excel 导入后列表默认显示的列，其他列默认隐藏，仍可在列表列选择器中手动打开
- `annotate_fields`: 参与拼接标注上下文的字段
- `answer_field`: 作为人工答案写入 `human_answer` 的列名
- `result_label_field`: 标注结果里用于判定标签的字段名

## 10. 数据存储说明

- 主数据库文件：`db.sqlite`
- 上传文件目录：`uploads`
- 导出结果通过页面导出按钮生成 Excel

## 11. 离线依赖说明

当前 `lib` 和 `lib/wheels` 已按当前开发环境准备完成，适合相同 Python 大版本和相近系统环境直接使用。

需要注意：

- `pandas`、`numpy`、`pydantic-core`、`PyYAML` 这类包包含平台相关二进制文件
- 如果目标机器的 Python 版本或系统架构差异较大，建议在目标环境重新生成一份 `lib` 和 `lib/wheels`

重建命令：

```bash
python3 -m pip install --target lib -r requirements.txt
python3 -m pip download -d lib/wheels -r requirements.txt
```

## 12. 常见问题

### 页面打不开

确认终端里已经成功启动 `uvicorn`，然后访问：

```text
http://127.0.0.1:5001
```

### 依赖导入失败

优先执行：

```bash
python3 -m pip install --no-index --find-links=lib/wheels -r requirements.txt
```

### 想接自己的后台标注接口

直接修改 [strategies.py](strategies.py) 中对应策略函数，把 `prompt_list`、`knowledge_list`、`concurrency`、`row_data`、`model_config_name` 一起传给你的接口即可。
