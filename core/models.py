"""ORM 数据模型 — 按 PRD 定义 11 张表"""
from datetime import datetime

from sqlalchemy import (
    Column, Integer, String, Text, Float, DateTime,
    ForeignKey, Index, UniqueConstraint
)

from core.database import Base


# ---------------------------------------------------------------------------
# 1. scenes — 场景表
# ---------------------------------------------------------------------------
class Scene(Base):
    __tablename__ = "scenes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, unique=True, nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------------------------------------------------------------------------
# 2. excel_files — 上传的 Excel 文件记录
# ---------------------------------------------------------------------------
class ExcelFile(Base):
    __tablename__ = "excel_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_name = Column(String, nullable=False)
    original_file_name = Column(String, nullable=False)
    scene_id = Column(Integer, ForeignKey("scenes.id"), nullable=True)
    total_rows = Column(Integer, default=0)
    annotated_count = Column(Integer, default=0)
    columns_info = Column(Text, nullable=True)       # JSON
    display_columns = Column(Text, nullable=True)    # JSON
    file_path = Column(String, nullable=True)
    cot_names = Column(Text, nullable=True)          # JSON
    annotate_config = Column(Text, nullable=True)    # JSON: 默认标注配置
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------------------------------------------------------------------------
# 3. excel_rows — Excel 原始数据行
# ---------------------------------------------------------------------------
class ExcelRow(Base):
    __tablename__ = "excel_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_id = Column(Integer, ForeignKey("excel_files.id"), nullable=True)
    # [DEPRECATED] 冗余字段，通过 file_id JOIN excel_files 获取
    file_name = Column(String, nullable=True)
    row_index = Column(Integer, nullable=False)
    data = Column(Text, nullable=False)              # JSON
    human_answer = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_excel_rows_file_id_row_index", "file_id", "row_index"),
    )


# ---------------------------------------------------------------------------
# 4. annotation_tasks — 标注任务
# ---------------------------------------------------------------------------
class AnnotationTask(Base):
    __tablename__ = "annotation_tasks"

    id = Column(String(36), primary_key=True)        # UUID
    file_id = Column(Integer, ForeignKey("excel_files.id"), nullable=True)
    scene_id = Column(Integer, ForeignKey("scenes.id"), nullable=True)
    # [DEPRECATED] 以下字段已废弃，不再读写，仅保留数据库兼容
    row_id = Column(Integer, nullable=True)
    prompt_version = Column(String, nullable=True)
    result = Column(Text, nullable=True)
    label = Column(String, nullable=True)
    match_type = Column(String, nullable=True)
    model_name = Column(String, nullable=False, default="")
    model_config = Column(String, nullable=False, default="")
    strategy = Column(String, nullable=False, default="方案A")
    prompt_names = Column(Text, nullable=True)       # JSON
    concurrency = Column(Integer, nullable=False, default=1)
    total_rows = Column(Integer, default=0)
    success_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)
    # [DEPRECATED] 以下统计字段已改为动态聚合，不再写入，保留字段仅为 SQLite 兼容
    accuracy = Column(Float, nullable=True)
    recall = Column(Float, nullable=True)
    precision_ = Column(Float, nullable=True)
    f1_score = Column(Float, nullable=True)
    status = Column(String, nullable=False, default="pending")
    error = Column(Text, nullable=True)
    row_data = Column(Text, nullable=True)             # 现役：存储标注目标行ID列表 [101,102,103]
    prompts = Column(Text, nullable=True)              # 现役：标注时读取 Prompt 配置
    knowledge = Column(Text, nullable=True)            # 现役：知识库配置
    duration_ms = Column(Integer, nullable=True)
    current_row_id = Column(Text, nullable=True)    # 当前正在标注的行ID列表（JSON数组）
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_annotation_tasks_file_id_created_at", "file_id", "created_at"),
    )


# ---------------------------------------------------------------------------
# 5. annotation_results — 标注结果
# ---------------------------------------------------------------------------
class AnnotationResult(Base):
    __tablename__ = "annotation_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(36), ForeignKey("annotation_tasks.id"), nullable=True)
    row_id = Column(Integer, ForeignKey("excel_rows.id"), nullable=True)
    model_name = Column(String, nullable=False)
    prompt_name = Column(String, nullable=True)
    prompt_version = Column(String, nullable=True)
    result = Column(Text, nullable=True)             # JSON
    label = Column(String, nullable=True)
    merged_label = Column(String, nullable=True)
    match_type = Column(String, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_annotation_results_task_id_row_id", "task_id", "row_id"),
        Index("ix_annotation_results_row_id_model_name", "row_id", "model_name"),
        UniqueConstraint("task_id", "row_id", "prompt_name", name="uq_task_row_prompt"),
    )


# ---------------------------------------------------------------------------
# 6. prompts — Prompt 文件（DB 管理）
# ---------------------------------------------------------------------------
class Prompt(Base):
    __tablename__ = "prompts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, ForeignKey("scenes.id"), nullable=True)
    name = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    file_type = Column(String, default=".prompt")
    role_name = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("scene_id", "name", name="uq_prompts_scene_name"),
    )


# ---------------------------------------------------------------------------
# 7. knowledge_files — 知识库文件（DB 管理）
# ---------------------------------------------------------------------------
class KnowledgeFile(Base):
    __tablename__ = "knowledge_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, ForeignKey("scenes.id"), nullable=True)
    name = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    file_type = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("scene_id", "name", name="uq_knowledge_files_scene_name"),
    )


# ---------------------------------------------------------------------------
# 8. rule_configs — 标注规则配置
# ---------------------------------------------------------------------------
class RuleConfig(Base):
    __tablename__ = "rule_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, ForeignKey("scenes.id"), unique=True, nullable=True)
    annotate_fields = Column(Text, nullable=True)    # JSON
    answer_field = Column(String, nullable=True)
    result_label_field = Column(String, nullable=True)
    excel_fields = Column(Text, nullable=True)       # JSON
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------------------------------------------------------------------------
# 9. error_books — 错题集
# ---------------------------------------------------------------------------
class ErrorBook(Base):
    __tablename__ = "error_books"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, ForeignKey("scenes.id"), nullable=True)
    file_id = Column(Integer, ForeignKey("excel_files.id"), nullable=True)
    cot_name = Column(String, nullable=True)
    row_id = Column(Integer, ForeignKey("excel_rows.id"), nullable=True)
    # 当 row_id 非空时通过 JOIN excel_rows.data 获取；row_id 为空时作为独立存储
    original_data = Column(Text, nullable=True)      # JSON
    expected_answer = Column(String, nullable=True)
    actual_output = Column(String, nullable=True)
    error_reason = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        Index("ix_error_books_scene_file_cot", "scene_id", "file_id", "cot_name"),
    )


# ---------------------------------------------------------------------------
# 10. chat_sessions — 对话会话
# ---------------------------------------------------------------------------
class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(String(36), primary_key=True)        # UUID
    model_name = Column(String, nullable=True)
    title = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------------------------------------------------------------------------
# 11. chat_messages — 对话消息
# ---------------------------------------------------------------------------
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(36), ForeignKey("chat_sessions.id"), nullable=False)
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_chat_messages_session_id_created_at", "session_id", "created_at"),
    )
