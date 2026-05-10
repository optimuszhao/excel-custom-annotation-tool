"""
标注策略插件 — 每个方法都是一种标注方案

统一签名：
    def strategy_xxx(prompt: str, row_data: dict, model_config_name: str, prompt_list: list, concurrency: int, knowledge_list: list) -> dict
    
参数：
    prompt: 拼接好的完整 Prompt 字符串（已填入数据）
    prompt_list: 所有 Prompt 文件原文列表，格式 [{"name": 文件名, "content": 原文}]
    concurrency: 前端传入的并发数量，真实后台实现时可使用
    knowledge_list: 所有知识文件原文列表，格式 [{"name": 文件名, "content": 原文}]
    row_data: 当前行按 rule.json 的 annotate_fields 过滤后的标注字段
    model_config_name: 模型配置文件名，如 "qwen-plus.yaml"
    
返回：
    字典，字段不固定，但必须包含 result_label_field 指定的字段（见 rule.json）
"""

import hashlib
import time


MOCK_ANNOTATION_DELAY_SECONDS = 10


def baseline_rule(prompt: str, row_data: dict, model_config_name: str, prompt_list: list = None, concurrency: int = 1, knowledge_list: list = None) -> dict:
    """
    baseline_rule — 在这里实现你的真实标注逻辑
    """
    # TODO: 在这里调用你的后台标注逻辑。
    # 可用参数：
    #   prompt: 已按当前行数据填充并拼接好的 Prompt 文本
    #   prompt_list: 所有 Prompt 文件原文列表 [{"name": 文件名, "content": 原文}]
    #   knowledge_list: 所有知识文件原文列表 [{"name": 文件名, "content": 原文}]
    #   concurrency: 当前组合配置的并发数量
    #   row_data: rule.json 中 annotate_fields 对应的字段数据
    #   model_config_name: 当前选择的模型配置文件名
    # 返回字段需要包含 rule.json 的 result_label_field。
    time.sleep(20)
    label = mock_label(row_data, model_config_name, "baseline_rule", prompt_list)
    return {
        "大模型标注答案": label,
        "大模型标注思考": f"baseline_rule Mock：{model_config_name} 根据标注字段固定判定为{label}",
        "测试的新字段": "ssss"
    }


def strict_rule(prompt: str, row_data: dict, model_config_name: str, prompt_list: list = None, concurrency: int = 1, knowledge_list: list = None) -> dict:
    """
    strict_rule — 在这里实现你的真实标注逻辑
    """
    # TODO: 在这里调用你的严格标注方案。
    time.sleep(MOCK_ANNOTATION_DELAY_SECONDS)
    label = mock_label(row_data, model_config_name, "strict_rule", prompt_list)
    return {
        "大模型标注答案": label,
        "大模型标注思考": f"strict_rule Mock：{model_config_name} 根据标注字段固定判定为{label}",
    }


def recall_rule(prompt: str, row_data: dict, model_config_name: str, prompt_list: list = None, concurrency: int = 1, knowledge_list: list = None) -> dict:
    """
    recall_rule — 在这里实现你的高召回标注逻辑
    """
    # TODO: 在这里调用你的高召回标注方案。
    time.sleep(MOCK_ANNOTATION_DELAY_SECONDS)
    label = mock_label(row_data, model_config_name, "recall_rule", prompt_list)
    return {
        "大模型标注答案": label,
        "大模型标注思考": f"recall_rule Mock：{model_config_name} 根据标注字段固定判定为{label}",
    }


def mock_label(row_data: dict, model_config_name: str, strategy_name: str, prompt_list) -> str:
    """
    固定 mock 标注，便于调试前端功能。
    TODO: 接入真实后台后可删除这个函数。
    """
    raw = f"{model_config_name}|{strategy_name}|{row_data}"
    digest = hashlib.md5(raw.encode("utf-8")).hexdigest()
    return "是" if int(digest[-1], 16) % 2 == 0 else "否"


# ---------------------------------------------------------------------------
# 策略注册表：key 是前端显示的名称，value 是对应的函数
# 新增策略只需：1. 写一个新函数  2. 加到这个字典里
# ---------------------------------------------------------------------------
STRATEGIES = {
    "方案A": baseline_rule,
    "方案B": strict_rule,
    "方案C": recall_rule,
}
