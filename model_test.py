import asyncio
import time


async def test_model_availability(model_config: str) -> dict:
    """
    测试模型是否可用
    Args:
        model_config: 模型配置文件名，如 'deepseek-chat.yaml'
    Returns:
        {"available": True/False, "message": "描述信息", "latency_ms": 响应时间}
    """
    # Mock 实现：等待2秒后返回可用
    start = time.time()
    await asyncio.sleep(2)
    elapsed_ms = int((time.time() - start) * 1000)
    return {
        "available": True,
        "message": "模型连接正常",
        "latency_ms": elapsed_ms
    }
