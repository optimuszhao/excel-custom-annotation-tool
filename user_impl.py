"""
👤 用户实现入口
========================================================================
这是整个工程**唯一**需要你修改的文件。把下面的 mock 替换成你真实的
大模型调用和标注算法即可，工程其他部分无需改动。

工程会自动从这里读取：
  - annotate_row()  : 单行标注（核心）
  - test_model()    : 模型可用性检测（点击"测试模型"按钮时触发）
  - STRATEGIES      : 策略注册表（前端"策略"下拉框的来源）
========================================================================
"""
import asyncio
import hashlib
import time


# ============================================================
# Mock 默认延时（开箱即用时模拟接口响应时间，接入真实模型后请删除）
# ============================================================
MOCK_ANNOTATION_DELAY_SECONDS = 30


# ============================================================
# 1) 单行标注：每标一行就被调一次
# ============================================================
def annotate_row(
    prompt: str,
    row_data: dict,
    model_config_name: str,
    prompt_list: list = None,
    concurrency: int = 1,
    knowledge_list: list = None,
) -> dict:
    """
    单行标注入口。

    入参：
      prompt              已按当前行数据**填充并拼接好**的完整 Prompt 文本
      row_data            当前行按 rule.json 的 annotate_fields 过滤后的字段值
      model_config_name   模型配置文件名，如 "qwen-plus.yaml"
      prompt_list         该场景下所有 Prompt 文件 [{"name": 名称, "content": 原文}]
      concurrency         前端选择的并发数
      knowledge_list      该场景下所有知识文件 [{"name": 名称, "content": 原文}]

    返回：
      dict —— 必须包含 rule.json 里 result_label_field 指定的字段
              （默认是 "大模型标注答案"）

    示例（真实接入大模型）：
      response = your_llm_client.chat(model=model_config_name, prompt=prompt)
      return {
          "大模型标注答案": parse_label(response),
          "大模型标注思考": response.thinking,
      }
    """
    # ---------- 以下为默认 mock，接入真实模型后请删除 ----------
    time.sleep(MOCK_ANNOTATION_DELAY_SECONDS)
    label = _mock_label(row_data, model_config_name, "annotate_row")
    return {
        "大模型标注答案": label,
        "大模型标注思考": f"Mock：{model_config_name} 根据标注字段固定判定为{label}",
    }


# ============================================================
# 2) 模型可用性检测：点击"测试模型"按钮时调用
# ============================================================
async def test_model(model_config_name: str) -> dict:
    """
    入参：
      model_config_name   模型配置文件名，如 "deepseek-chat.yaml"

    返回：
      {"available": bool, "message": str, "latency_ms": int}

    示例（真实检测）：
      start = time.time()
      try:
          await your_llm_client.ping(model_config_name)
          return {"available": True, "message": "OK",
                  "latency_ms": int((time.time()-start)*1000)}
      except Exception as e:
          return {"available": False, "message": str(e), "latency_ms": 0}
    """
    # ---------- 以下为默认 mock，接入真实模型后请删除 ----------
    start = time.time()
    await asyncio.sleep(2)
    return {
        "available": True,
        "message": "模型连接正常（mock）",
        "latency_ms": int((time.time() - start) * 1000),
    }


# ============================================================
# 3) 策略注册表：前端"策略"下拉框的选项
# ============================================================
# - key: 前端展示名称
# - value: 处理函数（签名同 annotate_row）
# 如果不同策略有差异化逻辑，可以拆成多个函数；否则统一指向 annotate_row 即可。
STRATEGIES = {
    "方案A": annotate_row,
    "方案B": annotate_row,
    "方案C": annotate_row,
}


# ============================================================
# 以下为 mock 辅助函数，接入真实模型后可删除
# ============================================================
def _mock_label(row_data: dict, model_config_name: str, strategy_name: str) -> str:
    raw = f"{model_config_name}|{strategy_name}|{row_data}"
    digest = hashlib.md5(raw.encode("utf-8")).hexdigest()
    return "是" if int(digest[-1], 16) % 2 == 0 else "否"
