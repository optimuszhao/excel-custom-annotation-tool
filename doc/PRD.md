# 数据飞轮 Prompt 标注调试台 PRD

## 1. 产品定位
数据飞轮是一个本地运行的后台管理型标注调试台，面向多场景 Excel 数据管理、多角色 Prompt 标注、知识与错题本维护、规则配置、模型联调、统计分析和结果导出。

产品目标是把业务场景、Excel 数据、Prompt 角色、知识资产、错题 few-shots 和标注结果统一管理，让标注人员和算法工程师可以在本地完成数据入库、规则调试、Prompt 蒸馏、批量标注和指标验证。

## 2. 技术方向

### 2.1 前端框架
推荐升级为 `React + Ant Design` 后台管理界面。

原因：
- 页面可以按路由拆分，减少当前单页一次性加载压力
- Ant Design 适合后台管理、树形场景、表格筛选、表单 CRUD、抽屉和侧边面板
- 数据表格可使用列级筛选、固定列、分页和更多操作菜单

### 2.2 内网依赖方案
公司内网环境使用本地化依赖交付方案：
- 使用 `package-lock.json` 或 `pnpm-lock.yaml` 固定版本
- 依赖包从可联网环境下载后交付到内网
- Ant Design 和 React 依赖保存在本地缓存或内网 npm 仓库
- 前端构建产物由 FastAPI 托管，运行时仍通过 `python3 app.py` 启动

最终运行目标：
- 开发环境：前端独立启动，后端 FastAPI 提供 API
- 本地交付环境：前端构建为静态资源，由 FastAPI 直接托管

## 3. 用户角色
- 标注运营：维护场景、导入 Excel、执行标注、查看结果、导出数据
- 算法/LLM 工程师：维护模型、Prompt、知识、错题本和规则，调试大模型输出
- 产品/研发协作角色：验证业务规则、评估指标、联调自定义标注方法

## 4. 核心业务流程
1. 创建或选择多级业务场景
2. 在场景下导入一个或多个 Excel
3. 维护当前场景下的 Prompt 角色、Excel、知识、错题本和规则
4. 在数据标注页选择场景、Excel、模型、标注角色和并发数
5. 按单条、选中或全量触发标注
6. 后端按角色加载 Prompt，并自动注入知识、规则和错题本内容
7. 多角色标注结果按且关系合并为最终答案
8. 页面展示列级筛选、标注结果、匹配类型和统计指标
9. 导出包含源数据、标注结果、统计指标和任务明细的 Excel

## 5. 场景管理

### 5.1 场景结构
场景支持多级树形结构，层级由用户自定义。

示例：
- `spn`
- `ipran`
- `ipran / 印尼`
- `ipran / 印尼 / 有回单`
- `ipran / 印尼 / 无回单`
- `ipran / 泰国`
- `ipran / 泰国 / 有回单`
- `ipran / 泰国 / 无回单`
- `t场景`
- `t场景 / 对话`
- `t场景 / 思维连`

### 5.2 场景功能
- 新增场景
- 编辑场景名称
- 调整父级场景
- 删除场景
- 查看场景下 Excel 数量、数据量、标注量
- 在数据标注、Excel 管理、Prompt、知识、错题本、规则中按场景筛选

### 5.3 场景资源边界
场景是业务资源的一级归属。以下资源都必须归属到具体场景：
- Excel
- Prompt
- 标注角色
- 知识
- 错题本
- 规则
- 标注任务
- 标注结果

不同场景可以维护完全不同的 Excel、Prompt、知识、错题本和规则。子场景默认拥有自己的资源集合，页面查询和标注默认只读取当前选中场景的资源。

场景切换后，页面需要同步刷新：
- Excel 列表
- Prompt 列表
- 标注角色列表
- 知识列表
- 错题本列表
- 规则列表
- 数据表格
- 统计指标

## 6. Excel 管理

### 6.1 存储关系
- 一个场景可以挂多个 Excel
- 每个 Excel 独立存储
- 每条数据记录关联所属场景和所属 Excel

### 6.2 功能
- 上传 Excel
- 选择所属场景
- 自定义 Excel 名称
- 查看 Excel 列字段
- 查看数据总量、已标注量、导入时间
- 删除 Excel 及其关联数据、标注结果和任务
- 支持在数据标注页切换不同 Excel

### 6.3 导入规则
导入时读取当前场景的规则配置：
- `excel_fields` 控制默认展示字段
- `annotate_fields` 控制参与标注的字段
- `answer_field` 控制人工答案字段
- `result_label_field` 控制模型答案字段

导入 Excel 时，若文件同时包含人工答案列和规则配置的标注答案列，系统直接计算匹配类型和统计指标。

## 7. 数据标注页面

### 7.1 顶部选择区
- 场景选择
- Excel 选择
- 模型选择
- 标注角色选择
- 并发数
- 导出

标注角色支持单选和多选。一个角色对应一个 Prompt，角色名称是 Prompt 的业务别名。

场景选择是顶层条件。Excel、角色、Prompt、知识、错题本和规则都基于当前场景加载。

### 7.2 表格能力
- 按当前场景和 Excel 加载数据
- 分页展示
- 列级筛选
- 列级排序
- 列显示控制
- 固定常用操作列
- 常用按钮直接展示
- 低频按钮收进“更多”
- 支持查看单元格完整内容
- 支持查看单条详情

### 7.3 列级筛选
过滤逻辑基于具体列：
- ID
- CoT 名称
- 匹配类型
- 人工答案
- 模型答案
- Excel 原始字段
- 标注角色结果字段

列级筛选只作用于当前场景和当前 Excel。

### 7.4 标注操作
- 单条标注
- 选中标注
- 当前筛选结果全量标注
- 清空当前模型/角色标注结果
- 删除选中数据
- 取消 pending 任务

## 8. 多角色 Prompt 标注

### 8.0 核心诉求
平台的核心价值是支持用户在前台对同一场景进行多种 Prompt 标注尝试。

示例：用户在 `SPN` 场景下维护 10 个标注角色，每个角色对应一个 Prompt。用户可以只选择角色 1 执行标注并查看准确率，也可以选择角色 1 和角色 2 同时执行标注。多角色场景下，平台负责调用每个角色对应的单角色标注方法，并按且关系计算最终答案。

业务方只需要实现单角色 Prompt 的标注方法。平台负责多角色调度、结果校验、答案合并、异常隔离、结果入库和准确率计算。

### 8.1 角色和 Prompt
- 标注角色保存到数据库
- 角色字段包含角色名称、关联 Prompt、所属场景、启用状态、排序
- 一个角色关联一个 Prompt
- Prompt 内容同步保存数据库和本地文件

### 8.2 标注请求
用户选择一个或多个角色后点击标注，前端只传必要 ID：
- 场景 ID
- Excel ID
- 行 ID
- 模型配置 ID
- 角色 ID 列表
- 并发数

后端根据 ID 自动查询：
- 当前场景的 Prompt 内容
- 当前场景的知识内容
- 当前场景和当前 CoT 名称匹配的错题本内容
- 当前场景的规则内容
- 模型配置
- 行数据

这样可以减少前端缓存和请求体体积。

### 8.3 Prompt 自动补全
Prompt 支持英文占位符：
- `{{knowledge}}`
- `{{rule}}`
- `{{fewshots}}`
- `{{cot_name}}`
- `{{scene_name}}`
- `{{row_data}}`

标注前由后端完成变量替换。

### 8.4 单角色标注方法边界
自定义标注方法只处理一个角色和一个 Prompt。

单角色标注方法输入：
- 当前角色补全后的 Prompt
- 当前行数据
- 当前模型配置
- 当前场景上下文

单角色标注方法输出：
- 一个结果对象
- 结果对象必须包含规则配置的结果标签字段

平台循环调用单角色标注方法，完成多角色标注。开发重点是标注框架，真实标注算法由业务方在 `strategies.py` 中接入。

### 8.5 返回要求
每个 Prompt 的返回都必须包含规则配置的结果标签字段，当前默认是：
- `大模型标注答案`

结果值必须是：
- `是`
- `否`

### 8.6 单条异常隔离
如果某个角色返回缺少结果标签字段，或结果值不是 `是` / `否`：
- 当前行标记为 `UNKNOWN`
- 当前行保存错误信息
- 当前行不参与准确率、查全率、查准率和 F1 分母
- 批量任务继续处理后续数据
- 其他数据不受影响

异常只影响这一条数据，不中断整批标注任务。

### 8.7 多角色合并
多个角色同时标注时，最终答案按且关系计算：
- 所有角色答案均为 `是`，最终答案为 `是`
- 任一角色答案为 `否`，最终答案为 `否`

系统同时保存：
- 每个角色的原始返回
- 每个角色的答案
- 每个角色的错误信息
- 合并后的最终答案
- 合并后的匹配类型

### 8.8 平台计算职责
平台需要负责以下计算：
- 根据所选角色逐个调用单角色标注方法
- 校验每个角色结果是否包含规则答案字段
- 校验每个角色答案是否为 `是` / `否`
- 多角色按且关系合并最终答案
- 根据人工答案和最终答案计算 TP、FN、FP、TN、UNKNOWN
- 根据统计公式计算准确率、查全率、查准率和 F1

## 9. Prompt 管理

### 9.1 存储方式
Prompt 同时保存到数据库和本地文件。

数据库用于：
- 前台列表查询
- 后台标注时按 ID 读取
- 关联角色
- 减少前端缓存内容

本地文件用于：
- 人工查看
- 版本同步
- 本地备份

### 9.2 功能
- 新增 Prompt
- 编辑 Prompt
- 删除 Prompt
- 绑定场景
- 按场景筛选
- 设置英文变量占位符
- 预览替换后的 Prompt
- 保存时同步数据库和本地文件

Prompt 列表默认只展示当前场景的 Prompt。角色绑定 Prompt 时，只能选择当前场景下的 Prompt。

## 10. 知识管理

### 10.1 存储方式
知识内容同时保存到数据库和本地文件。

### 10.2 功能
- 新增知识
- 编辑知识
- 删除知识
- 绑定场景
- 按场景筛选
- 大文本编辑
- 保存时同步数据库和本地文件
- 标注时通过 `{{knowledge}}` 注入 Prompt

知识列表默认只展示当前场景的知识。标注时只注入当前场景启用的知识。

## 11. 错题本管理

### 11.1 定位
错题本用于维护 few-shots。知识由用户维护，错题按场景和 CoT 名称区分。

### 11.2 维度
错题本唯一分组建议：
- 场景
- CoT 名称

### 11.3 功能
- 新增错题本
- 编辑错题本
- 删除错题本
- 按场景筛选
- 按 CoT 名称筛选
- 大文本保存 few-shots
- 标注时通过 `{{fewshots}}` 注入 Prompt

错题本列表默认只展示当前场景的错题本。标注时根据当前数据行的 CoT 名称匹配当前场景下的 few-shots。

## 12. 规则管理

### 12.1 存储方式
规则同时保存到数据库和本地文件。

### 12.2 功能
- 新增规则
- 编辑规则
- 删除规则
- 绑定场景
- 按场景筛选
- 控制 Excel 字段、标注字段、人工答案字段、模型答案字段
- 标注时通过 `{{rule}}` 注入 Prompt

规则列表默认只展示当前场景的规则。导入 Excel、标注、统计和导出都使用当前场景的有效规则。

## 13. 模型配置

### 13.1 功能
- 新增模型配置
- 编辑模型配置
- 删除模型配置
- 保存 API 地址、模型名、密钥占位符、默认参数
- 标注任务和对话测试共用模型配置

## 14. 侧边大模型对话

### 14.1 定位
侧边对话用于蒸馏规则、测试 Prompt、验证模型输出和辅助整理知识。

### 14.2 功能
- 选择模型
- 输入对话内容
- 引用当前场景
- 引用当前 Prompt
- 引用当前知识
- 引用当前错题本
- 查看模型返回
- 支持复制结果

对话引用的 Prompt、知识、错题本和规则都来自当前场景。

### 14.3 页面形态
推荐使用右侧抽屉或固定侧边栏，避免打断主标注流程。

## 15. 统计口径

### 15.1 匹配类型
- TP：人工答案为 `是`，模型答案为 `是`
- FN：人工答案为 `是`，模型答案为 `否`
- FP：人工答案为 `否`，模型答案为 `是`
- TN：人工答案为 `否`，模型答案为 `否`
- UNKNOWN：人工答案或模型答案缺失、非法或无法归一化

### 15.2 指标公式
- 已标注量：`TP + FN + FP + TN`
- 准确率：`(TP + TN) / (TP + FN + FP + TN)`
- 正确查全率：`TP / (TP + FN)`
- 错误查全率：`TN / (TN + FP)`
- 正确查准率：`TP / (TP + FP)`
- 错误查准率：`TN / (TN + FN)`
- F1：`2TP / (2TP + FP + FN)`

`UNKNOWN` 只展示数量，指标分母使用 `TP + FN + FP + TN`。

## 16. 浏览器标签图标
网站增加 favicon。

要求：
- 浏览器标签栏显示项目图标
- 静态资源由 FastAPI 托管
- HTML 模板引用 favicon

## 17. 数据模型建议

### 17.1 Scene
- `id`
- `parent_id`
- `name`
- `path`
- `sort_order`
- `created_at`
- `updated_at`

### 17.2 ExcelFile
- `id`
- `scene_id`
- `display_name`
- `original_file_name`
- `stored_file_path`
- `columns_json`
- `row_count`
- `created_at`
- `updated_at`

### 17.3 ExcelRow
- `id`
- `scene_id`
- `excel_file_id`
- `row_index`
- `data`
- `human_answer`
- `created_at`

### 17.4 PromptAsset
- `id`
- `scene_id`
- `name`
- `file_name`
- `content`
- `file_path`
- `enabled`
- `created_at`
- `updated_at`

### 17.5 AnnotationRole
- `id`
- `scene_id`
- `name`
- `prompt_id`
- `enabled`
- `sort_order`
- `created_at`
- `updated_at`

### 17.6 KnowledgeAsset
- `id`
- `scene_id`
- `name`
- `file_name`
- `content`
- `file_path`
- `enabled`
- `created_at`
- `updated_at`

### 17.7 FewshotBook
- `id`
- `scene_id`
- `cot_name`
- `name`
- `content`
- `enabled`
- `created_at`
- `updated_at`

### 17.8 RuleAsset
- `id`
- `scene_id`
- `name`
- `file_name`
- `content`
- `file_path`
- `enabled`
- `created_at`
- `updated_at`

### 17.9 AnnotationResult
- `id`
- `scene_id`
- `excel_file_id`
- `row_id`
- `model_config_id`
- `role_ids_json`
- `model_name`
- `final_label`
- `match_type`
- `role_results_json`
- `prompt_snapshot_json`
- `duration_ms`
- `created_at`

### 17.10 AnnotationTask
- `id`
- `scene_id`
- `excel_file_id`
- `row_id`
- `model_config_id`
- `role_ids_json`
- `status`
- `result`
- `error`
- `duration_ms`
- `created_at`
- `started_at`
- `finished_at`

## 18. 页面规划

### 18.1 主导航
- 数据标注
- Excel 管理
- 场景管理
- Prompt 管理
- 标注角色
- 知识管理
- 错题本管理
- 规则管理
- 模型配置
- 统计数据

### 18.2 页面拆分
每个模块独立页面开发，Ant Layout 承载左侧导航和顶部栏。

推荐路由：
- `/annotation`
- `/excels`
- `/scenes`
- `/prompts`
- `/roles`
- `/knowledge`
- `/fewshots`
- `/rules`
- `/models`
- `/stats`

## 19. 接口规划

### 19.1 场景
- `GET /api/scenes`
- `POST /api/scenes`
- `PUT /api/scenes/{id}`
- `DELETE /api/scenes/{id}`

### 19.2 Excel
- `GET /api/excels?scene_id={scene_id}`
- `POST /api/excels/upload`
- `GET /api/excels/{id}`
- `DELETE /api/excels/{id}`
- `GET /api/excels/{id}/rows`

### 19.3 标注
- `POST /api/annotations`
- `GET /api/annotations/tasks`
- `POST /api/annotations/tasks/{id}/cancel`
- `POST /api/annotations/tasks/cancel-pending`
- `DELETE /api/annotations`

### 19.4 资产管理
- `GET /api/prompts?scene_id={scene_id}`
- `POST /api/prompts`
- `PUT /api/prompts/{id}`
- `DELETE /api/prompts/{id}`
- `GET /api/roles?scene_id={scene_id}`
- `POST /api/roles`
- `PUT /api/roles/{id}`
- `DELETE /api/roles/{id}`
- `GET /api/knowledge?scene_id={scene_id}`
- `POST /api/knowledge`
- `PUT /api/knowledge/{id}`
- `DELETE /api/knowledge/{id}`
- `GET /api/fewshots?scene_id={scene_id}`
- `POST /api/fewshots`
- `PUT /api/fewshots/{id}`
- `DELETE /api/fewshots/{id}`
- `GET /api/rules?scene_id={scene_id}`
- `POST /api/rules`
- `PUT /api/rules/{id}`
- `DELETE /api/rules/{id}`

### 19.5 模型与对话
- `GET /api/models`
- `POST /api/models`
- `PUT /api/models/{id}`
- `DELETE /api/models/{id}`
- `POST /api/chat`

### 19.6 统计与导出
- `GET /api/stats`
- `GET /api/stats/by-combo`
- `GET /api/export`

## 20. 迁移策略

### 20.1 第一阶段：PRD 和数据模型
- 整理新 PRD
- 设计新增表结构
- 保留旧接口可运行
- 增加场景、Excel、Prompt、角色、知识、错题本、规则表

### 20.2 第二阶段：后端能力
- 实现场景树 CRUD
- 实现 Excel 独立入库
- 实现资产数据库和本地文件同步
- 实现后端 Prompt 变量替换
- 实现单角色标注方法调用框架
- 实现多角色标注任务调度和且关系合并
- 实现单条标注异常隔离，异常数据标记为 UNKNOWN
- 修正统计分母

### 20.3 第三阶段：前端重构
- 搭建 React + Ant Design
- 拆分页面路由
- 实现 Excel 管理和场景树
- 实现数据标注页
- 实现资产 CRUD 页面
- 实现右侧大模型对话

### 20.4 第四阶段：验收
- 使用多级场景验证数据隔离
- 使用多个 Excel 验证独立标注和统计
- 使用多角色验证且关系合并
- 使用缺少结果字段的异常返回验证单条异常隔离
- 使用列级筛选验证筛选准确性
- 使用导入已有答案的 Excel 验证指标直接计算

## 21. 验收标准
- 可创建多级场景，并在场景下管理多个 Excel
- 可上传 Excel 并独立入库
- 可在数据标注页切换场景和 Excel
- 不同场景可维护各自的 Excel、Prompt、角色、知识、错题本和规则
- 切换场景后，页面资源列表和统计指标按当前场景刷新
- 可创建角色并绑定 Prompt
- 可单选或多选角色执行标注
- 多角色结果按且关系生成最终答案
- 业务方只需要实现单角色 Prompt 标注方法，平台完成多角色调度和最终答案计算
- 单个角色返回缺少规则答案字段时，仅当前行标记为 UNKNOWN，批量任务继续执行
- Prompt、知识、错题本、规则可 CRUD，并同步数据库和本地文件
- Prompt 可通过英文占位符自动注入知识、规则、错题本和行数据
- 表格支持列级筛选
- 统计指标按公式计算，UNKNOWN 展示为独立数量
- 导入已有人工答案和标注答案的 Excel 后可直接计算指标
- 浏览器标签栏显示项目图标
- 侧边大模型对话可用于 Prompt 和规则测试

## 22. 开发边界
- 核心标注方法保持在 `strategies.py` 扩展
- 当前 mock 标注逻辑保留为联调方案
- 真实大模型或业务标注接口由业务方接入
- 本次开发重点是平台结构、数据流、页面拆分、资产管理和统计口径
