"""
通用工具函数
"""
import json
import re


def render_prompt(template: str, row_data: dict, scene_id, db) -> dict:
    """
    渲染 prompt 模板，替换所有占位符。

    占位符规则：
    - {字段名}            → row_data 中对应列的值（向后兼容）
    - {knowledge.名称}    → 知识库该名称文件的 content
    - {errorbook.cot名称} → 错题本按 cot_name 聚合的错题文本（最新5条）

    Returns:
        rendered              — 渲染后的完整 prompt
        ctx_used              — 实际命中的变量 {key: value}
        missing_placeholders  — 未命中的占位符列表
    """
    from models import KnowledgeFile, ErrorBook

    ctx: dict = {}

    # 1. Excel 行数据（不加前缀，向后兼容）
    for k, v in (row_data or {}).items():
        ctx[k] = str(v) if v is not None else ""

    if scene_id:
        # 2. 知识库：{knowledge.名称}
        kf_list = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).all()
        for kf in kf_list:
            ctx[f"knowledge.{kf.name}"] = kf.content or ""

        # 3. 错题本：{errorbook.cot名称}，每个 cot_name 最新 5 条
        error_entries = (
            db.query(ErrorBook)
            .filter(ErrorBook.scene_id == scene_id)
            .order_by(ErrorBook.created_at.desc())
            .all()
        )
        cot_groups: dict = {}
        for entry in error_entries:
            cot = entry.cot_name or "__default__"
            if cot not in cot_groups:
                cot_groups[cot] = []
            if len(cot_groups[cot]) < 5:
                cot_groups[cot].append(entry)

        for cot_name, entries in cot_groups.items():
            lines = []
            for i, e in enumerate(entries, 1):
                original = ""
                if e.original_data:
                    try:
                        data = json.loads(e.original_data)
                        if isinstance(data, dict):
                            original = "、".join(f"{k}={v}" for k, v in data.items())
                        else:
                            original = str(data)
                    except Exception:
                        original = e.original_data

                parts = [f"案例{i}："]
                if original:
                    parts.append(f"- 输入：{original}")
                if e.expected_answer:
                    parts.append(f"- 期望答案：{e.expected_answer}")
                if e.actual_output:
                    parts.append(f"- 实际输出：{e.actual_output}")
                if e.error_reason:
                    parts.append(f"- 错误原因：{e.error_reason}")
                lines.append("\n".join(parts))
            ctx[f"errorbook.{cot_name}"] = "\n\n".join(lines)

    # 扫描所有占位符并替换
    all_placeholders = re.findall(r'\{([^{}]+)\}', template)
    rendered = template
    ctx_used: dict = {}
    missing: list = []

    for placeholder in dict.fromkeys(all_placeholders):  # 保序去重
        if placeholder in ctx:
            rendered = rendered.replace(f"{{{placeholder}}}", str(ctx[placeholder]))
            ctx_used[placeholder] = ctx[placeholder]
        else:
            missing.append(placeholder)

    return {
        "rendered": rendered,
        "ctx_used": ctx_used,
        "missing_placeholders": missing,
    }
