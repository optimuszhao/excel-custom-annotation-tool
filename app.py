"""
数据飞轮 Prompt 标注调试台 — FastAPI 后端
"""

import json
import os
import random
import shutil
import tempfile
import math
import hashlib
from urllib.parse import quote
from contextlib import asynccontextmanager
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from io import BytesIO
from pathlib import Path
from threading import Lock, Thread, Event
from typing import Optional, List, Dict, Any
from uuid import uuid4

BASE_DIR = Path(__file__).resolve().parent

import pandas as pd
import yaml
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, or_, func
from sqlalchemy import inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker
from strategies import STRATEGIES

# ---------------------------------------------------------------------------
# 路径 & 目录
# ---------------------------------------------------------------------------
UPLOADS_DIR = BASE_DIR / "uploads"
PROMPTS_DIR = BASE_DIR / "prompts"
KNOWLEDGE_DIR = BASE_DIR / "knowledge"
MODELS_DIR = BASE_DIR / "models"
CONFIG_DIR = BASE_DIR / "config"
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

for d in [UPLOADS_DIR, PROMPTS_DIR, KNOWLEDGE_DIR, MODELS_DIR, CONFIG_DIR, TEMPLATES_DIR, STATIC_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# 数据库
# ---------------------------------------------------------------------------
DATABASE_URL = f"sqlite:///{BASE_DIR / 'db.sqlite'}"
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    pool_size=30,
    max_overflow=20,
    pool_timeout=30,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class ExcelRow(Base):
    __tablename__ = "excel_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_name = Column(String, nullable=False)
    row_index = Column(Integer, nullable=False)
    data = Column(Text, nullable=False)  # JSON
    human_answer = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AnnotationResult(Base):
    __tablename__ = "annotation_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    row_id = Column(Integer, nullable=False)  # FK → ExcelRow.id
    model_name = Column(String, nullable=False)
    prompt_version = Column(String, nullable=True)
    result = Column(Text, nullable=False)  # JSON
    label = Column(String, nullable=True)
    match_type = Column(String, nullable=True)  # TP/FN/FP/TN
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AnnotationTask(Base):
    __tablename__ = "annotation_tasks"

    id = Column(String, primary_key=True)
    row_id = Column(Integer, nullable=False)
    model_name = Column(String, nullable=False)
    model_config = Column(String, nullable=False)
    strategy = Column(String, nullable=False)
    concurrency = Column(Integer, nullable=False, default=1)
    prompt_version = Column(String, nullable=True)
    row_data = Column(Text, nullable=False)
    prompts = Column(Text, nullable=False)
    knowledge = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="pending")
    result = Column(Text, nullable=True)
    label = Column(String, nullable=True)
    match_type = Column(String, nullable=True)
    error = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)


Base.metadata.create_all(bind=engine)


def ensure_schema():
    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("annotation_results")}
    task_columns = {col["name"] for col in inspector.get_columns("annotation_tasks")}
    with engine.begin() as conn:
        if "duration_ms" not in columns:
            conn.execute(text("ALTER TABLE annotation_results ADD COLUMN duration_ms INTEGER"))
        if "concurrency" not in task_columns:
            conn.execute(text("ALTER TABLE annotation_tasks ADD COLUMN concurrency INTEGER DEFAULT 1 NOT NULL"))
        if "knowledge" not in task_columns:
            conn.execute(text("ALTER TABLE annotation_tasks ADD COLUMN knowledge TEXT"))


ensure_schema()

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
def start_annotation_scheduler():
    global TASK_RECOVERY_THREAD
    reset_interrupted_annotation_tasks()
    schedule_pending_annotation_tasks()
    if TASK_RECOVERY_THREAD is None or not TASK_RECOVERY_THREAD.is_alive():
        TASK_RECOVERY_STOP.clear()
        TASK_RECOVERY_THREAD = Thread(target=annotation_recovery_loop, daemon=True)
        TASK_RECOVERY_THREAD.start()


def stop_annotation_scheduler():
    TASK_RECOVERY_STOP.set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_annotation_scheduler()
    try:
        yield
    finally:
        stop_annotation_scheduler()


app = FastAPI(title="数据飞轮 Prompt 标注调试台", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

MAX_TASK_CONCURRENCY = 20
MAX_ACTIVE_TASKS_PER_COMBO = 10
TASK_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_TASK_CONCURRENCY)
TASK_ACTIVE_STATUSES = {"pending", "running"}
TASK_CREATE_LOCK = Lock()
TASK_SCHEDULER_LOCK = Lock()
TASK_RUNNING_IDS = set()
TASK_ACTIVE_BY_COMBO = defaultdict(int)
TASK_RECOVERY_STOP = Event()
TASK_RECOVERY_THREAD = None
TASK_STALE_RUNNING_SECONDS = 30 * 60


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def safe_prompt_path(name: str) -> Path:
    """校验 Prompt 文件名安全性，防止目录遍历"""
    pure_name = Path(name).name  # 只保留文件名部分
    if not (pure_name.endswith(".txt") or pure_name.endswith(".prompt")):
        raise HTTPException(status_code=400, detail="Invalid prompt file name")
    fp = PROMPTS_DIR / pure_name
    if not str(fp.resolve()).startswith(str(PROMPTS_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid prompt path")
    return fp


def safe_knowledge_path(name: str) -> Path:
    """校验知识文件名安全性，防止目录遍历"""
    pure_name = Path(name).name
    if not pure_name.endswith((".json", ".jsonl", ".txt")):
        raise HTTPException(status_code=400, detail="Invalid knowledge file name")
    fp = KNOWLEDGE_DIR / pure_name
    if not str(fp.resolve()).startswith(str(KNOWLEDGE_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid knowledge path")
    return fp


def safe_model_path(name: str) -> Path:
    """校验模型配置文件名安全性，防止目录遍历"""
    pure_name = Path(name).name
    if not pure_name.endswith(".yaml"):
        pure_name = f"{pure_name}.yaml"
    fp = MODELS_DIR / pure_name
    if not str(fp.resolve()).startswith(str(MODELS_DIR.resolve())):
        raise HTTPException(status_code=400, detail="Invalid model path")
    return fp


def normalize_binary_label(value: str) -> str:
    text = str(value or "").strip()
    yes_values = {"是", "对", "正确", "yes", "YES", "true", "True", "1"}
    no_values = {"否", "错", "错误", "no", "NO", "false", "False", "0"}
    if text in yes_values:
        return "是"
    if text in no_values:
        return "否"
    return ""


def calc_match_type(human_answer: str, label: str) -> str:
    h = normalize_binary_label(human_answer)
    l_ = normalize_binary_label(label)
    if h == "是" and l_ == "是":
        return "TP"
    if h == "是" and l_ == "否":
        return "FN"
    if h == "否" and l_ == "是":
        return "FP"
    if h == "否" and l_ == "否":
        return "TN"
    return "UNKNOWN"


def ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator > 0 else 0


def format_percent_ratio(value: Optional[float]) -> str:
    if value is None:
        return "0%"
    return f"{value * 100:.1f}%"


def split_combo_name(combo_name: str) -> tuple[str, str]:
    combo_name = (combo_name or "").strip()
    if combo_name.endswith(")") and "(" in combo_name:
        model_name, strategy_name = combo_name.rsplit("(", 1)
        return model_name.strip(), strategy_name[:-1].strip()
    return combo_name, ""


def sanitize_export_filename_part(value: str, fallback: str) -> str:
    value = (value or "").strip()
    if not value:
        return fallback
    invalid_chars = '<>:"/\\|?*'
    sanitized = "".join("_" if ch in invalid_chars or ord(ch) < 32 else ch for ch in value)
    sanitized = sanitized.strip().strip(".")
    return sanitized or fallback


def resolve_export_source_file_name(rows: list) -> str:
    names = []
    for row in rows:
        name = (row.file_name or "").strip()
        if name:
            names.append(name)
    if not names:
        return "data.xlsx"
    unique_names = list(dict.fromkeys(names))
    if len(unique_names) == 1:
        return unique_names[0]
    return "多文件.xlsx"


def build_export_filename(combo_name: str, stats_payload: dict, source_file_name: str) -> str:
    model_name, strategy_name = split_combo_name(combo_name)
    annotated_count = int(stats_payload.get("annotated") or 0)
    accuracy_text = format_percent_ratio(stats_payload.get("accuracy"))
    model_part = sanitize_export_filename_part(model_name, "unknown_model")
    strategy_part = sanitize_export_filename_part(strategy_name, "default_strategy")
    source_stem = sanitize_export_filename_part(Path(source_file_name or "").stem, "data")
    return f"标注{annotated_count}条数据（准确率{accuracy_text}）后结果+{model_part}+{strategy_part}+{source_stem}.xlsx"


def build_stats_payload(total: int, annotations: list, model: str = "all", all_models: list = None) -> dict:
    annotated = len(annotations)
    tp = sum(1 for a in annotations if a.match_type == "TP")
    fn = sum(1 for a in annotations if a.match_type == "FN")
    fp = sum(1 for a in annotations if a.match_type == "FP")
    tn = sum(1 for a in annotations if a.match_type == "TN")
    unknown = annotated - tp - fn - fp - tn
    return {
        "model": model,
        "total": total,
        "annotated": annotated,
        "tp": tp,
        "fn": fn,
        "fp": fp,
        "tn": tn,
        "unknown": unknown,
        "accuracy": ratio(tp + tn, annotated),
        "positive_recall": ratio(tp, tp + fn),
        "negative_recall": ratio(tn, tn + fp),
        "positive_precision": ratio(tp, tp + fp),
        "negative_precision": ratio(tn, tn + fn),
        "f1_score": ratio(2 * tp, 2 * tp + fp + fn),
        "models": all_models or [],
    }


def format_duration_ms(duration_ms: Optional[int]) -> str:
    if duration_ms is None:
        return ""
    if duration_ms < 1000:
        return f"{duration_ms}ms"
    seconds = duration_ms / 1000
    if seconds < 60:
        return f"{seconds:.2f}s"
    minutes = int(seconds // 60)
    remain = seconds % 60
    return f"{minutes}m{remain:.1f}s"


def get_model_display_name(model_config_name: str, strategy_name: str) -> str:
    base_model_name = model_config_name.replace(".yaml", "") if model_config_name.endswith(".yaml") else model_config_name
    return f"{base_model_name}({strategy_name})"


def get_prompt_version(prompts: Any) -> str:
    if isinstance(prompts, list):
        return ",".join([str(p.get("name", "")) for p in prompts if p.get("name")])
    return ",".join(sorted(prompts.keys())) if prompts else ""


def rest_ir(prompt: str, row_data: dict, model_config_name: str, strategy_name: str = "方案A", prompt_list: list = None, concurrency: int = 1, knowledge_list: list = None) -> dict:
    """
    调用大模型标注接口 — 根据策略名调用对应的标注方案

    参数：
        prompt: 拼接好的完整 Prompt 字符串（已填入数据）
        model_config_name: 模型配置文件名，如 "qwen-plus.yaml"
        strategy_name: 标注策略名称，如 "方案A"

    返回：
        大模型返回的字典，字段不固定
        但必须包含 result_label_field 指定的字段（见 rule.json，默认"大模型标注答案"）
        示例：{"大模型标注答案": "对", "大模型标注思考": "xxx"}
    """
    strategy_fn = STRATEGIES.get(strategy_name)
    if not strategy_fn:
        # 兜底：用第一个策略
        strategy_fn = list(STRATEGIES.values())[0]
    try:
        return strategy_fn(prompt, row_data, model_config_name, prompt_list or [], concurrency, knowledge_list or [])
    except TypeError:
        return strategy_fn(prompt, row_data, model_config_name, prompt_list or [], concurrency)


def read_uploaded_table(file_path: Path) -> pd.DataFrame:
    suffix = file_path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    return pd.read_excel(file_path)


def read_uploaded_content(filename: str, content: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    buffer = BytesIO(content)
    if suffix == ".csv":
        return pd.read_csv(buffer)
    return pd.read_excel(buffer)


def import_dataframe(filename: str, df: pd.DataFrame) -> int:
    rule = load_rule()
    answer_field = rule.get("answer_field", "人工答案")

    db = SessionLocal()
    try:
        count = 0
        for idx, row in df.iterrows():
            row_dict = {}
            for col in df.columns:
                val = row[col]
                row_dict[col] = None if pd.isna(val) else val

            human_answer = row_dict.get(answer_field)
            if human_answer is not None:
                human_answer = str(human_answer).strip()

            db.add(ExcelRow(
                file_name=filename,
                row_index=int(idx),
                data=json.dumps(row_dict, ensure_ascii=False, default=str),
                human_answer=human_answer,
            ))
            count += 1
        db.commit()
        return count
    finally:
        db.close()


def build_prompt(row_data: dict, prompts: dict) -> str:
    prompt_parts = []
    for _, prompt_content in prompts.items():
        try:
            filled = prompt_content.format(**row_data)
        except KeyError:
            filled = prompt_content
        prompt_parts.append(filled)
    return "\n\n---\n\n".join(prompt_parts)


def annotate_one_row(row_data: dict, model_config_name: str, prompts: Any, strategy_name: str = "方案A", concurrency: int = 1, knowledge: Any = None) -> dict:
    """
    单行标注入口。批量标注、全量标注都会循环调用这里。
    TODO: 你的真实标注逻辑写在 strategies.py 对应方案函数里。
    """
    if isinstance(prompts, list):
        prompt_map = {item.get("name", str(i)): item.get("content", "") for i, item in enumerate(prompts)}
        prompt_list = prompts
    else:
        prompt_map = prompts or {}
        prompt_list = [{"name": name, "content": content} for name, content in prompt_map.items()]
    full_prompt = build_prompt(row_data, prompt_map)
    knowledge_list = knowledge if isinstance(knowledge, list) else []
    return rest_ir(full_prompt, row_data, model_config_name, strategy_name, prompt_list, concurrency, knowledge_list)


def custom_full_dataset_classify(rows: list, model_config_name: str, strategy_name: str) -> list:
    """
    自定义全量标注 mock：一次接收完整数据集，按行生成分类结果。
    真实逻辑后续可以替换这里，返回结构保持 row_id + result 即可。
    """
    categories = ["核心样本", "风险关注", "普通样本", "待复核", "低优先级"]
    total = len(rows)
    classified = []
    for index, item in enumerate(rows, start=1):
        row_id = item["row_id"]
        row_data = item.get("data") or {}
        source = json.dumps(row_data, ensure_ascii=False, sort_keys=True, default=str)
        digest = hashlib.sha1(f"{model_config_name}|{strategy_name}|{row_id}|{source}".encode("utf-8")).hexdigest()
        score = int(digest[:8], 16)
        category = categories[score % len(categories)]
        confidence = round(0.62 + (score % 33) / 100, 2)
        classified.append({
            "row_id": row_id,
            "label": category,
            "result": {
                "大模型标注答案": category,
                "自定义分类": category,
                "分类置信度": confidence,
                "分类说明": f"custom_full_dataset_mock 基于全量 {total} 条数据生成第 {index} 条分类",
                "分类来源": "custom_full_dataset_mock",
                "全量样本数": total,
            },
        })
    return classified


def annotate_rows_concurrently(valid_items: list, model_config_name: str, prompts: Any, strategy_name: str, concurrency: int) -> list:
    """
    并发调用单条标注入口。标注实现仍然集中在 annotate_one_row / strategies.py。
    """
    if not valid_items:
        return []

    max_workers = min(max(1, concurrency), len(valid_items))

    def run_one(item: dict) -> dict:
        row_id = item["row_id"]
        try:
            result = annotate_one_row(item["data"], model_config_name, prompts, strategy_name, concurrency)
            return {"row_id": row_id, "result": result}
        except Exception as exc:
            return {"row_id": row_id, "error": str(exc)}

    if max_workers == 1:
        return [run_one(item) for item in valid_items]

    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {executor.submit(run_one, item): item for item in valid_items}
        for future in as_completed(future_map):
            results.append(future.result())
    return results


def clamp_task_concurrency(value: Any) -> int:
    try:
        parsed = int(value or 1)
    except (TypeError, ValueError):
        parsed = 1
    return min(MAX_TASK_CONCURRENCY, max(1, parsed))


def reset_interrupted_annotation_tasks():
    db = SessionLocal()
    try:
        with TASK_SCHEDULER_LOCK:
            TASK_RUNNING_IDS.clear()
            TASK_ACTIVE_BY_COMBO.clear()
        reset_count = db.query(AnnotationTask).filter(AnnotationTask.status == "running").update(
            {AnnotationTask.status: "pending", AnnotationTask.started_at: None},
            synchronize_session=False,
        )
        db.commit()
        return reset_count
    finally:
        db.close()


def recover_orphaned_annotation_tasks() -> int:
    db = SessionLocal()
    try:
        with TASK_SCHEDULER_LOCK:
            running_ids = set(TASK_RUNNING_IDS)
        query = db.query(AnnotationTask).filter(AnnotationTask.status == "running")
        if running_ids:
            query = query.filter(~AnnotationTask.id.in_(list(running_ids)))
        recovered = query.update(
            {AnnotationTask.status: "pending", AnnotationTask.started_at: None},
            synchronize_session=False,
        )
        db.commit()
        return recovered
    finally:
        db.close()


def recover_stale_annotation_tasks() -> int:
    cutoff = datetime.utcnow().timestamp() - TASK_STALE_RUNNING_SECONDS
    db = SessionLocal()
    try:
        running_tasks = (
            db.query(AnnotationTask)
            .filter(AnnotationTask.status == "running", AnnotationTask.started_at.isnot(None))
            .all()
        )
        stale_ids = [
            task.id for task in running_tasks
            if task.started_at and task.started_at.timestamp() < cutoff
        ]
        if not stale_ids:
            return 0
        with TASK_SCHEDULER_LOCK:
            for task_id in stale_ids:
                TASK_RUNNING_IDS.discard(task_id)
            TASK_ACTIVE_BY_COMBO.clear()
        recovered = db.query(AnnotationTask).filter(AnnotationTask.id.in_(stale_ids)).update(
            {AnnotationTask.status: "pending", AnnotationTask.started_at: None},
            synchronize_session=False,
        )
        db.commit()
        return recovered
    finally:
        db.close()


def ensure_annotation_scheduler_health():
    recover_orphaned_annotation_tasks()
    recover_stale_annotation_tasks()
    schedule_pending_annotation_tasks()


def annotation_recovery_loop():
    while not TASK_RECOVERY_STOP.wait(5):
        try:
            ensure_annotation_scheduler_health()
        except Exception as exc:
            print(f"[annotation scheduler] recovery failed: {exc}")


def schedule_pending_annotation_tasks():
    task_ids_to_submit = []
    with TASK_SCHEDULER_LOCK:
        available = MAX_TASK_CONCURRENCY - len(TASK_RUNNING_IDS)
        if available <= 0:
            return

        db = SessionLocal()
        try:
            now = datetime.utcnow()
            tasks_by_combo = defaultdict(list)
            pending_combos = (
                db.query(
                    AnnotationTask.model_name,
                    func.min(AnnotationTask.created_at).label("oldest_created_at"),
                )
                .filter(AnnotationTask.status == "pending")
                .group_by(AnnotationTask.model_name)
                .order_by(func.min(AnnotationTask.created_at).asc())
                .all()
            )
            combo_order = [combo_name for combo_name, _ in pending_combos if combo_name]
            for combo_name in combo_order:
                tasks_by_combo[combo_name] = (
                    db.query(AnnotationTask)
                    .filter(
                        AnnotationTask.status == "pending",
                        AnnotationTask.model_name == combo_name,
                    )
                    .order_by(AnnotationTask.created_at.asc())
                    .limit(MAX_TASK_CONCURRENCY)
                    .all()
                )

            cursor = 0
            while available > 0 and combo_order:
                made_progress = False
                for combo_name in list(combo_order):
                    if available <= 0:
                        break
                    combo_tasks = tasks_by_combo.get(combo_name) or []
                    while combo_tasks and available > 0:
                        task = combo_tasks.pop(0)
                        combo_limit = min(clamp_task_concurrency(task.concurrency), MAX_ACTIVE_TASKS_PER_COMBO)
                        if TASK_ACTIVE_BY_COMBO[task.model_name] >= combo_limit:
                            break
                        task.status = "running"
                        task.started_at = now
                        task.error = None
                        TASK_RUNNING_IDS.add(task.id)
                        TASK_ACTIVE_BY_COMBO[task.model_name] += 1
                        task_ids_to_submit.append(task.id)
                        available -= 1
                        made_progress = True
                        break
                    if not combo_tasks:
                        tasks_by_combo.pop(combo_name, None)
                        combo_order.remove(combo_name)
                cursor += 1
                if not made_progress or cursor > MAX_TASK_CONCURRENCY * 2:
                    break

            if task_ids_to_submit:
                db.commit()
        except Exception:
            db.rollback()
            for task_id in task_ids_to_submit:
                TASK_RUNNING_IDS.discard(task_id)
            TASK_ACTIVE_BY_COMBO.clear()
            raise
        finally:
            db.close()

    for task_id in task_ids_to_submit:
        TASK_EXECUTOR.submit(run_annotation_task, task_id)


def forget_annotation_tasks(task_ids: list):
    db = SessionLocal()
    with TASK_SCHEDULER_LOCK:
        for task_id in task_ids:
            TASK_RUNNING_IDS.discard(task_id)
        TASK_ACTIVE_BY_COMBO.clear()
        try:
            if TASK_RUNNING_IDS:
                running = (
                    db.query(AnnotationTask.id, AnnotationTask.model_name)
                    .filter(
                        AnnotationTask.id.in_(list(TASK_RUNNING_IDS)),
                        AnnotationTask.status == "running",
                    )
                    .all()
                )
                valid_running_ids = set()
                for task_id, model_name in running:
                    valid_running_ids.add(task_id)
                    TASK_ACTIVE_BY_COMBO[model_name] += 1
                TASK_RUNNING_IDS.intersection_update(valid_running_ids)
        finally:
            db.close()


def release_scheduled_task(task_id: str, model_name: str):
    with TASK_SCHEDULER_LOCK:
        TASK_RUNNING_IDS.discard(task_id)
        if model_name:
            TASK_ACTIVE_BY_COMBO[model_name] = max(0, TASK_ACTIVE_BY_COMBO[model_name] - 1)
            if TASK_ACTIVE_BY_COMBO[model_name] == 0:
                TASK_ACTIVE_BY_COMBO.pop(model_name, None)
    schedule_pending_annotation_tasks()


def run_annotation_task(task_id: str):
    model_name = ""
    started = datetime.utcnow()
    try:
        db = SessionLocal()
        try:
            task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
            if not task or task.status == "cancelled":
                return
            model_name = task.model_name
            row_id = task.row_id
            model_config = task.model_config
            strategy = task.strategy
            task_concurrency = clamp_task_concurrency(task.concurrency)
            row_data = json.loads(task.row_data) if task.row_data else {}
            prompts = json.loads(task.prompts) if task.prompts else []
            knowledge = json.loads(task.knowledge) if task.knowledge else []
            prompt_version = task.prompt_version
        finally:
            db.close()

        rule = load_rule()
        result_label_field = rule.get("result_label_field", "label")
        try:
            result = annotate_one_row(row_data, model_config, prompts, strategy, task_concurrency, knowledge)
            finished = datetime.utcnow()
            duration_ms = int((finished - started).total_seconds() * 1000)

            db = SessionLocal()
            try:
                task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
                if not task:
                    return
                if task.status == "cancelled":
                    task.finished_at = finished
                    task.duration_ms = duration_ms
                    db.commit()
                    return

                db_row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
                label = result.get(result_label_field, "")
                match_type = calc_match_type(db_row.human_answer if db_row else "", label)
                result_json = json.dumps(result, ensure_ascii=False)

                existing = (
                    db.query(AnnotationResult)
                    .filter(
                        AnnotationResult.row_id == row_id,
                        AnnotationResult.model_name == model_name,
                    )
                    .first()
                )
                if existing:
                    existing.prompt_version = prompt_version
                    existing.result = result_json
                    existing.label = label
                    existing.match_type = match_type
                    existing.duration_ms = duration_ms
                    existing.created_at = finished
                else:
                    db.add(AnnotationResult(
                        row_id=row_id,
                        model_name=model_name,
                        prompt_version=prompt_version,
                        result=result_json,
                        label=label,
                        match_type=match_type,
                        duration_ms=duration_ms,
                        created_at=finished,
                    ))

                task.status = "success"
                task.result = result_json
                task.label = label
                task.match_type = match_type
                task.duration_ms = duration_ms
                task.finished_at = finished
                db.commit()
            finally:
                db.close()
        except Exception as exc:
            finished = datetime.utcnow()
            db = SessionLocal()
            try:
                task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
                if task and task.status != "cancelled":
                    task.status = "failed"
                    task.error = str(exc)
                    task.duration_ms = int((finished - started).total_seconds() * 1000)
                    task.finished_at = finished
                    db.commit()
            finally:
                db.close()
    finally:
        release_scheduled_task(task_id, model_name)


def run_annotation_task_legacy(task_id: str):
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task or task.status == "cancelled":
            return
        if task.status != "running":
            task.status = "running"
            task.started_at = datetime.utcnow()
            db.commit()

        row_data = json.loads(task.row_data) if task.row_data else {}
        prompts = json.loads(task.prompts) if task.prompts else []
        knowledge = json.loads(task.knowledge) if task.knowledge else []
        rule = load_rule()
        result_label_field = rule.get("result_label_field", "label")

        started = datetime.utcnow()
        try:
            result = annotate_one_row(row_data, task.model_config, prompts, task.strategy, max(1, task.concurrency or 1), knowledge)
            finished = datetime.utcnow()
            duration_ms = int((finished - started).total_seconds() * 1000)

            db.refresh(task)
            if task.status == "cancelled":
                task.finished_at = finished
                task.duration_ms = duration_ms
                db.commit()
                return

            db_row = db.query(ExcelRow).filter(ExcelRow.id == task.row_id).first()
            label = result.get(result_label_field, "")
            match_type = calc_match_type(db_row.human_answer if db_row else "", label)
            result_json = json.dumps(result, ensure_ascii=False)

            existing = (
                db.query(AnnotationResult)
                .filter(
                    AnnotationResult.row_id == task.row_id,
                    AnnotationResult.model_name == task.model_name,
                )
                .first()
            )
            if existing:
                existing.prompt_version = task.prompt_version
                existing.result = result_json
                existing.label = label
                existing.match_type = match_type
                existing.duration_ms = duration_ms
                existing.created_at = finished
            else:
                db.add(AnnotationResult(
                    row_id=task.row_id,
                    model_name=task.model_name,
                    prompt_version=task.prompt_version,
                    result=result_json,
                    label=label,
                    match_type=match_type,
                    duration_ms=duration_ms,
                    created_at=finished,
                ))

            task.status = "success"
            task.result = result_json
            task.label = label
            task.match_type = match_type
            task.duration_ms = duration_ms
            task.finished_at = finished
            db.commit()
        except Exception as exc:
            finished = datetime.utcnow()
            task.status = "failed"
            task.error = str(exc)
            task.duration_ms = int((finished - started).total_seconds() * 1000)
            task.finished_at = finished
            db.commit()
    finally:
        db.close()


def run_annotation_task_batch(task_ids: list, concurrency: int):
    if not task_ids:
        return
    max_workers = min(clamp_task_concurrency(concurrency), len(task_ids))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(run_annotation_task, task_id) for task_id in task_ids]
        for future in as_completed(futures):
            future.result()


def serialize_task(task: AnnotationTask) -> dict:
    return {
        "id": task.id,
        "row_id": task.row_id,
        "model_name": task.model_name,
        "model_config": task.model_config,
        "strategy": task.strategy,
        "concurrency": task.concurrency,
        "status": task.status,
        "label": task.label,
        "match_type": task.match_type,
        "error": task.error,
        "duration_ms": task.duration_ms,
        "duration_text": format_duration_ms(task.duration_ms),
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "finished_at": task.finished_at.isoformat() if task.finished_at else None,
    }


# ---------------------------------------------------------------------------
# Rule 配置 API
# ---------------------------------------------------------------------------
def load_rule() -> dict:
    """读取 rule.json 配置"""
    rule_path = CONFIG_DIR / "rule.json"
    if rule_path.exists():
        with open(rule_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "excel_fields": [],
        "annotate_fields": [],
        "answer_field": "",
        "result_label_field": "label"
    }


def load_settings() -> dict:
    settings_path = CONFIG_DIR / "settings.json"
    if settings_path.exists():
        with open(settings_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "default_model": "",
        "default_strategy": "",
        "default_concurrency": 1,
    }


@app.get("/api/settings")
async def get_settings():
    return load_settings()


@app.put("/api/settings")
async def save_settings(request: Request):
    body = await request.json()
    body["default_concurrency"] = clamp_task_concurrency(body.get("default_concurrency", 1))
    settings_path = CONFIG_DIR / "settings.json"
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return {"success": True, "settings": body}


@app.get("/api/rule")
async def get_rule():
    """读取 rule.json 配置"""
    return load_rule()


@app.put("/api/rule")
async def save_rule(request: Request):
    """保存 rule.json 配置"""
    body = await request.json()
    rule_path = CONFIG_DIR / "rule.json"
    with open(rule_path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return {"success": True}


# ---------------------------------------------------------------------------
# 1. GET / — 渲染首页
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


# ---------------------------------------------------------------------------
# 2. POST /api/upload — Excel 上传
# ---------------------------------------------------------------------------
@app.post("/api/upload")
async def upload_excel(file: UploadFile = File(...)):
    content = await file.read()
    df = read_uploaded_content(file.filename, content)
    columns = df.columns.tolist()
    imported = import_dataframe(file.filename, df)
    return {"columns": columns, "filename": file.filename, "imported": imported}


# ---------------------------------------------------------------------------
# 3. POST /api/import — 选定字段入库
# ---------------------------------------------------------------------------
@app.post("/api/import")
async def import_data(body: dict):
    raise HTTPException(status_code=410, detail="Import from saved upload is disabled; use /api/upload")


# ---------------------------------------------------------------------------
# 4. GET /api/rows — 分页查询
# ---------------------------------------------------------------------------
def query_filtered_sorted_rows(
    db,
    search: Optional[str] = None,
    model: Optional[str] = None,
    filter: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: str = "asc",
) -> list:
    query = db.query(ExcelRow)
    if search:
        ann_row_ids = [
            r[0] for r in db.query(AnnotationResult.row_id)
            .filter(
                or_(
                    AnnotationResult.model_name.contains(search),
                    AnnotationResult.result.contains(search),
                    AnnotationResult.label.contains(search),
                    AnnotationResult.match_type.contains(search),
                )
            )
            .distinct()
            .all()
        ]
        search_conditions = [
            ExcelRow.data.contains(search),
            ExcelRow.human_answer.contains(search),
            ExcelRow.file_name.contains(search),
        ]
        if ann_row_ids:
            search_conditions.append(ExcelRow.id.in_(ann_row_ids))
        if str(search).isdigit():
            search_conditions.append(ExcelRow.id == int(search))
            search_conditions.append(ExcelRow.row_index == int(search))
        query = query.filter(or_(*search_conditions))

    if filter:
        if filter == "unlabeled":
            annotated_subq = db.query(AnnotationResult.row_id)
            if model:
                annotated_subq = annotated_subq.filter(AnnotationResult.model_name == model)
            annotated_ids = annotated_subq.distinct().subquery()
            query = query.filter(~ExcelRow.id.in_(db.query(annotated_ids)))
        else:
            match_subq = db.query(AnnotationResult.row_id).filter(
                AnnotationResult.match_type == filter
            )
            if model:
                match_subq = match_subq.filter(AnnotationResult.model_name == model)
            match_ids = match_subq.distinct().subquery()
            query = query.filter(ExcelRow.id.in_(db.query(match_ids)))

    all_rows = query.all()
    if sort_by:
        reverse = sort_dir == "desc"

        def sort_value(row: ExcelRow):
            data_dict = json.loads(row.data) if row.data else {}
            if sort_by == "id":
                return row.id
            if sort_by == "human_answer":
                return row.human_answer or ""
            if sort_by == "row_index":
                return row.row_index
            if sort_by == "match_type":
                ann = None
                if model:
                    ann = (
                        db.query(AnnotationResult)
                        .filter(AnnotationResult.row_id == row.id, AnnotationResult.model_name == model)
                        .first()
                    )
                return ann.match_type if ann else ""
            if sort_by.startswith("data:"):
                return data_dict.get(sort_by.split(":", 1)[1]) or ""
            return row.id

        return sorted(all_rows, key=sort_value, reverse=reverse)
    return sorted(all_rows, key=lambda r: r.id)


def serialize_excel_row(db, row: ExcelRow, model: Optional[str] = None) -> dict:
    data_dict = json.loads(row.data) if row.data else {}
    ann_query = db.query(AnnotationResult).filter(AnnotationResult.row_id == row.id)
    annotations_raw = ann_query.all()
    annotations = {}
    row_match_type = None
    for ann in annotations_raw:
        ann_data = json.loads(ann.result) if ann.result else {}
        if ann.duration_ms is not None:
            ann_data["标注耗时"] = format_duration_ms(ann.duration_ms)
            ann_data["标注耗时(ms)"] = ann.duration_ms
        annotations[ann.model_name] = ann_data
        if model and ann.model_name == model:
            row_match_type = ann.match_type
    return {
        "id": row.id,
        "data": data_dict,
        "human_answer": row.human_answer,
        "results": annotations,
        "match_type": row_match_type,
    }


@app.get("/api/rows")
async def get_rows(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100000),
    search: Optional[str] = Query(None),
    model: Optional[str] = Query(None),
    filter: Optional[str] = Query(None),
    sort_by: Optional[str] = Query(None),
    sort_dir: str = Query("asc"),
):
    db = SessionLocal()
    try:
        query = db.query(ExcelRow)
        if search:
            ann_row_ids = [
                r[0] for r in db.query(AnnotationResult.row_id)
                .filter(
                    or_(
                        AnnotationResult.model_name.contains(search),
                        AnnotationResult.result.contains(search),
                        AnnotationResult.label.contains(search),
                        AnnotationResult.match_type.contains(search),
                    )
                )
                .distinct()
                .all()
            ]
            search_conditions = [
                ExcelRow.data.contains(search),
                ExcelRow.human_answer.contains(search),
                ExcelRow.file_name.contains(search),
            ]
            if ann_row_ids:
                search_conditions.append(ExcelRow.id.in_(ann_row_ids))
            if str(search).isdigit():
                search_conditions.append(ExcelRow.id == int(search))
                search_conditions.append(ExcelRow.row_index == int(search))
            query = query.filter(or_(*search_conditions))

        # filter 筛选逻辑
        if filter:
            if filter == "unlabeled":
                # 找出没有标注记录的行（或指定模型没有标注的行）
                annotated_subq = db.query(AnnotationResult.row_id)
                if model:
                    annotated_subq = annotated_subq.filter(AnnotationResult.model_name == model)
                annotated_ids = annotated_subq.distinct().subquery()
                query = query.filter(~ExcelRow.id.in_(db.query(annotated_ids)))
            else:
                # TP/FN/FP/TN 筛选
                match_subq = db.query(AnnotationResult.row_id).filter(
                    AnnotationResult.match_type == filter
                )
                if model:
                    match_subq = match_subq.filter(AnnotationResult.model_name == model)
                match_ids = match_subq.distinct().subquery()
                query = query.filter(ExcelRow.id.in_(db.query(match_ids)))

        all_rows = query.all()

        if sort_by:
            reverse = sort_dir == "desc"

            def sort_value(row: ExcelRow):
                data_dict = json.loads(row.data) if row.data else {}
                if sort_by == "id":
                    return row.id
                if sort_by == "human_answer":
                    return row.human_answer or ""
                if sort_by == "row_index":
                    return row.row_index
                if sort_by == "match_type":
                    ann = None
                    if model:
                        ann = (
                            db.query(AnnotationResult)
                            .filter(AnnotationResult.row_id == row.id, AnnotationResult.model_name == model)
                            .first()
                        )
                    return ann.match_type if ann else ""
                if sort_by.startswith("data:"):
                    return data_dict.get(sort_by.split(":", 1)[1]) or ""
                return row.id

            all_rows = sorted(all_rows, key=sort_value, reverse=reverse)
        else:
            all_rows = sorted(all_rows, key=lambda r: r.id)

        total = len(all_rows)
        pages = max(1, math.ceil(total / page_size))
        page = min(page, pages)
        offset = (page - 1) * page_size
        rows = all_rows[offset: offset + page_size]

        result_list = []
        for r in rows:
            data_dict = json.loads(r.data) if r.data else {}
            # 查该行所有标注
            ann_query = db.query(AnnotationResult).filter(AnnotationResult.row_id == r.id)
            annotations_raw = ann_query.all()
            annotations = {}
            row_match_type = None
            for a in annotations_raw:
                ann_data = json.loads(a.result) if a.result else {}
                if a.duration_ms is not None:
                    ann_data["标注耗时"] = format_duration_ms(a.duration_ms)
                    ann_data["标注耗时(ms)"] = a.duration_ms
                annotations[a.model_name] = ann_data
                if model and a.model_name == model:
                    row_match_type = a.match_type
            result_list.append({
                "id": r.id,
                "data": data_dict,
                "human_answer": r.human_answer,
                "results": annotations,  # 改名：annotations → results
                "match_type": row_match_type,  # 新增：当前模型的匹配类型
            })
        return {
            "rows": result_list,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": pages,
        }
    finally:
        db.close()


@app.get("/api/rows/range-ids")
async def get_row_range_ids(
    start: int = Query(1, ge=1),
    end: int = Query(1, ge=1),
    search: Optional[str] = Query(None),
    model: Optional[str] = Query(None),
    filter: Optional[str] = Query(None),
    sort_by: Optional[str] = Query(None),
    sort_dir: str = Query("asc"),
):
    db = SessionLocal()
    try:
        rows = query_filtered_sorted_rows(db, search, model, filter, sort_by, sort_dir)
        total = len(rows)
        if total == 0:
            return {"ids": [], "total": 0, "start": 0, "end": 0}
        left = max(1, min(start, end))
        right = min(total, max(start, end))
        ids = [row.id for row in rows[left - 1:right]]
        return {"ids": ids, "total": total, "start": left, "end": right}
    finally:
        db.close()


@app.post("/api/rows/by-ids")
async def get_rows_by_ids(body: dict):
    raw_ids = body.get("row_ids", [])
    ids = [int(x) for x in raw_ids if str(x).isdigit()]
    db = SessionLocal()
    try:
        if not ids:
            return {"rows": []}
        rows = db.query(ExcelRow).filter(ExcelRow.id.in_(ids)).all()
        row_map = {row.id: row for row in rows}
        result = [serialize_excel_row(db, row_map[row_id], body.get("model")) for row_id in ids if row_id in row_map]
        return {"rows": result}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 5. GET /api/fields — 读取默认字段
# ---------------------------------------------------------------------------
@app.get("/api/fields")
async def get_fields():
    fields_file = CONFIG_DIR / "fields.txt"
    if not fields_file.exists():
        return {"fields": []}
    text = fields_file.read_text(encoding="utf-8").strip()
    fields = [line.strip() for line in text.splitlines() if line.strip()]
    return {"fields": fields}


# ---------------------------------------------------------------------------
# 6. GET /api/stats — 统计接口
# ---------------------------------------------------------------------------
@app.get("/api/stats")
async def get_stats(model: Optional[str] = Query(None)):
    db = SessionLocal()
    try:
        total = db.query(ExcelRow).count()
        all_models_rows = db.query(AnnotationResult.model_name).distinct().all()
        all_models = [r[0] for r in all_models_rows]

        ann_query = db.query(AnnotationResult)
        if model:
            ann_query = ann_query.filter(AnnotationResult.model_name == model)

        annotations = ann_query.all()
        return build_stats_payload(total, annotations, model or "all", all_models)
    finally:
        db.close()


@app.get("/api/stats/all")
async def get_all_stats():
    db = SessionLocal()
    try:
        total = db.query(ExcelRow).count()
        model_names = [r[0] for r in db.query(AnnotationResult.model_name).distinct().all()]
        items = []
        for model_name in sorted(model_names):
            annotations = (
                db.query(AnnotationResult)
                .filter(AnnotationResult.model_name == model_name)
                .all()
            )
            items.append(build_stats_payload(total, annotations, model_name, model_names))
        return {"items": items, "total": total}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 7. POST /api/annotate — 统一标注接口（支持单条/批量/全部）
# ---------------------------------------------------------------------------
@app.post("/api/annotate")
def annotate(body: dict):
    """
    统一标注接口

    请求体：
        rows: [{"id": 1, "data": {...}}, ...] — 需要标注的数据列表
        model_config: "qwen-plus.yaml" — 模型配置文件名
        prompts: {"api_label.prompt": "内容...", ...} — 所有Prompt文件内容
    """
    rows: list = body.get("rows", [])
    model_config_name: str = body.get("model_config", "unknown.yaml")
    prompts: Any = body.get("prompts", [])
    knowledge: Any = body.get("knowledge", [])
    strategy_name: str = body.get("strategy", "方案A")
    concurrency: int = clamp_task_concurrency(body.get("concurrency", 1))

    model_name = get_model_display_name(model_config_name, strategy_name)
    prompt_version = get_prompt_version(prompts)

    db = SessionLocal()
    try:
        created_tasks = []
        error_results = []
        with TASK_CREATE_LOCK:
            for row_item in rows:
                row_id = row_item.get("id")
                row_data = row_item.get("data", {})
                db_row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
                if not db_row:
                    error_results.append({"row_id": row_id, "error": "not found"})
                    continue

                existing_task = (
                    db.query(AnnotationTask)
                    .filter(
                        AnnotationTask.row_id == row_id,
                        AnnotationTask.model_name == model_name,
                        AnnotationTask.status.in_(list(TASK_ACTIVE_STATUSES)),
                    )
                    .first()
                )
                if existing_task:
                    error_results.append({
                        "row_id": row_id,
                        "error": "task already running",
                        "task": serialize_task(existing_task),
                    })
                    continue

                task = AnnotationTask(
                    id=str(uuid4()),
                    row_id=row_id,
                    model_name=model_name,
                    model_config=model_config_name,
                    strategy=strategy_name,
                    concurrency=concurrency,
                    prompt_version=prompt_version,
                    row_data=json.dumps(row_data, ensure_ascii=False, default=str),
                    prompts=json.dumps(prompts, ensure_ascii=False, default=str),
                    knowledge=json.dumps(knowledge, ensure_ascii=False, default=str),
                    status="pending",
                )
                db.add(task)
                created_tasks.append(task)

            db.commit()
        if created_tasks:
            schedule_pending_annotation_tasks()

        return {
            "success": len(error_results) == 0,
            "queued": len(created_tasks),
            "tasks": [serialize_task(task) for task in created_tasks],
            "errors": error_results,
            "message": f"{len(error_results)} 条任务创建失败" if error_results else "",
        }
    except Exception as e:
        db.rollback()
        return {"success": False, "message": str(e)}
    finally:
        db.close()


@app.post("/api/custom-full-annotate")
def custom_full_annotate(body: dict):
    model_config_name: str = body.get("model_config", "unknown.yaml")
    strategy_name: str = body.get("strategy", "方案A")
    model_name = get_model_display_name(model_config_name, strategy_name)

    db = SessionLocal()
    started = datetime.utcnow()
    try:
        rows = db.query(ExcelRow).order_by(ExcelRow.id.asc()).all()
        if not rows:
            return {"success": False, "message": "暂无数据可标注", "annotated": 0}

        payload = [
            {
                "row_id": row.id,
                "data": json.loads(row.data) if row.data else {},
            }
            for row in rows
        ]
        classified = custom_full_dataset_classify(payload, model_config_name, strategy_name)
        finished = datetime.utcnow()
        total_duration_ms = int((finished - started).total_seconds() * 1000)
        row_duration_ms = max(1, total_duration_ms // max(1, len(classified)))

        existing_results = (
            db.query(AnnotationResult)
            .filter(AnnotationResult.model_name == model_name)
            .all()
        )
        existing_by_row = {ann.row_id: ann for ann in existing_results}

        for item in classified:
            row_id = item["row_id"]
            label = item.get("label", "")
            result = item.get("result", {})
            result["全量标注耗时(ms)"] = total_duration_ms
            result_json = json.dumps(result, ensure_ascii=False, default=str)
            existing = existing_by_row.get(row_id)
            if existing:
                existing.prompt_version = "custom_full_dataset_mock"
                existing.result = result_json
                existing.label = label
                existing.match_type = "UNKNOWN"
                existing.duration_ms = row_duration_ms
                existing.created_at = finished
            else:
                db.add(AnnotationResult(
                    row_id=row_id,
                    model_name=model_name,
                    prompt_version="custom_full_dataset_mock",
                    result=result_json,
                    label=label,
                    match_type="UNKNOWN",
                    duration_ms=row_duration_ms,
                    created_at=finished,
                ))

        db.commit()
        return {
            "success": True,
            "annotated": len(classified),
            "model_name": model_name,
            "duration_ms": total_duration_ms,
        }
    except Exception as e:
        db.rollback()
        return {"success": False, "message": str(e), "annotated": 0}
    finally:
        db.close()


@app.delete("/api/annotations")
async def clear_annotations(body: dict):
    row_ids = body.get("row_ids", [])
    model_name = body.get("model_name")
    db = SessionLocal()
    try:
        query = db.query(AnnotationResult)
        if row_ids:
            query = query.filter(AnnotationResult.row_id.in_(row_ids))
        if model_name:
            query = query.filter(AnnotationResult.model_name == model_name)
        deleted = query.delete(synchronize_session=False)
        db.commit()
        return {"success": True, "deleted": deleted}
    except Exception as e:
        db.rollback()
        return {"success": False, "message": str(e)}
    finally:
        db.close()


@app.delete("/api/rows")
async def delete_rows(body: dict):
    raw_ids = body.get("row_ids", [])
    row_ids = [int(x) for x in raw_ids if str(x).isdigit()]
    confirmed = bool(body.get("confirmed"))
    if not row_ids:
        return {"success": False, "message": "请选择要删除的数据"}

    db = SessionLocal()
    try:
        existing_ids = [r[0] for r in db.query(ExcelRow.id).filter(ExcelRow.id.in_(row_ids)).all()]
        if not existing_ids:
            return {"success": False, "message": "数据不存在或已删除"}

        active_count = (
            db.query(AnnotationTask)
            .filter(
                AnnotationTask.row_id.in_(existing_ids),
                AnnotationTask.status.in_(list(TASK_ACTIVE_STATUSES)),
            )
            .count()
        )
        if active_count > 0 and not confirmed:
            return {
                "success": False,
                "requires_confirmation": True,
                "active_task_count": active_count,
                "row_count": len(existing_ids),
                "message": f"有 {active_count} 个标注任务正在执行或排队",
            }

        task_ids = [
            r[0] for r in db.query(AnnotationTask.id)
            .filter(AnnotationTask.row_id.in_(existing_ids))
            .all()
        ]
        annotation_count = db.query(AnnotationResult).filter(
            AnnotationResult.row_id.in_(existing_ids)
        ).delete(synchronize_session=False)
        task_count = db.query(AnnotationTask).filter(
            AnnotationTask.row_id.in_(existing_ids)
        ).delete(synchronize_session=False)
        row_count = db.query(ExcelRow).filter(
            ExcelRow.id.in_(existing_ids)
        ).delete(synchronize_session=False)
        db.commit()
        forget_annotation_tasks(task_ids)
        schedule_pending_annotation_tasks()
        return {
            "success": True,
            "deleted_rows": row_count,
            "deleted_annotations": annotation_count,
            "deleted_tasks": task_count,
            "cancelled_active_tasks": active_count,
        }
    except Exception as e:
        db.rollback()
        return {"success": False, "message": str(e)}
    finally:
        db.close()


@app.get("/api/annotation-tasks")
async def list_annotation_tasks(
    model: Optional[str] = Query(None),
    row_ids: Optional[str] = Query(None),
    active_only: bool = Query(False),
):
    ensure_annotation_scheduler_health()
    ids = []
    if row_ids:
        ids = [int(x) for x in row_ids.split(",") if x.strip().isdigit()]
    db = SessionLocal()
    try:
        query = db.query(AnnotationTask)
        if model:
            query = query.filter(AnnotationTask.model_name == model)
        if ids:
            query = query.filter(AnnotationTask.row_id.in_(ids))
        if active_only:
            query = query.filter(AnnotationTask.status.in_(list(TASK_ACTIVE_STATUSES)))
        limit = max(500, len(ids)) if ids else 500
        tasks = query.order_by(AnnotationTask.created_at.desc()).limit(limit).all()
        return {"tasks": [serialize_task(task) for task in tasks]}
    finally:
        db.close()


@app.get("/api/annotation-tasks/summary")
async def annotation_task_summary(model: Optional[str] = Query(None)):
    ensure_annotation_scheduler_health()
    db = SessionLocal()
    try:
        query = db.query(AnnotationTask)
        if model:
            query = query.filter(AnnotationTask.model_name == model)
        pending_count = query.filter(AnnotationTask.status == "pending").count()
        running_count = query.filter(AnnotationTask.status == "running").count()
        success_count = query.filter(AnnotationTask.status == "success").count()
        failed_count = query.filter(AnnotationTask.status == "failed").count()
        cancelled_count = query.filter(AnnotationTask.status == "cancelled").count()
        return {
            "pending": pending_count,
            "running": running_count,
            "success": success_count,
            "failed": failed_count,
            "cancelled": cancelled_count,
            "active": pending_count + running_count,
            "total": pending_count + running_count + success_count + failed_count + cancelled_count,
        }
    finally:
        db.close()


@app.post("/api/annotation-tasks/cancel-pending")
async def cancel_pending_annotation_tasks(body: dict = Body(...)):
    model = body.get("model")
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    db = SessionLocal()
    try:
        tasks = (
            db.query(AnnotationTask)
            .filter(AnnotationTask.model_name == model, AnnotationTask.status == "pending")
            .all()
        )
        now = datetime.utcnow()
        task_ids = [task.id for task in tasks]
        for task in tasks:
            task.status = "cancelled"
            task.finished_at = now
        db.commit()
        if task_ids:
            forget_annotation_tasks(task_ids)
            schedule_pending_annotation_tasks()
        return {"success": True, "cancelled": len(task_ids), "model": model}
    except Exception as exc:
        db.rollback()
        return {"success": False, "message": str(exc), "cancelled": 0, "model": model}
    finally:
        db.close()


@app.post("/api/annotation-tasks/{task_id}/cancel")
async def cancel_annotation_task(task_id: str):
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if task.status in TASK_ACTIVE_STATUSES:
            task.status = "cancelled"
            task.finished_at = datetime.utcnow()
            db.commit()
        return {"success": True, "task": serialize_task(task)}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 8. GET /api/strategies — 策略列表
# ---------------------------------------------------------------------------
@app.get("/api/strategies")
async def get_strategies():
    """获取所有可用的标注策略列表"""
    return {"strategies": list(STRATEGIES.keys())}


# ---------------------------------------------------------------------------
# 9. GET /api/prompts — Prompt 文件列表
# ---------------------------------------------------------------------------
@app.get("/api/prompts")
async def list_prompts():
    files = sorted([f.name for f in PROMPTS_DIR.glob("*.prompt")] + [f.name for f in PROMPTS_DIR.glob("*.txt")])
    return {"prompts": files}


# ---------------------------------------------------------------------------
# 10. GET /api/prompts/{name} — 读取 Prompt
# ---------------------------------------------------------------------------
@app.get("/api/prompts/{name}")
async def read_prompt(name: str):
    fp = safe_prompt_path(name)
    if not fp.exists():
        return {"error": "Prompt file not found"}
    content = fp.read_text(encoding="utf-8")
    return {"name": name, "content": content}


# ---------------------------------------------------------------------------
# 11. PUT /api/prompts/{name} — 保存 Prompt
# ---------------------------------------------------------------------------
@app.put("/api/prompts/{name}")
async def save_prompt(name: str, body: dict):
    fp = safe_prompt_path(name)
    fp.write_text(body["content"], encoding="utf-8")
    return {"success": True}


# ---------------------------------------------------------------------------
# 12. GET /api/knowledge — 知识文件列表
# ---------------------------------------------------------------------------
@app.get("/api/knowledge")
async def list_knowledge():
    files = sorted(
        [f.name for f in KNOWLEDGE_DIR.glob("*.json")]
        + [f.name for f in KNOWLEDGE_DIR.glob("*.jsonl")]
        + [f.name for f in KNOWLEDGE_DIR.glob("*.txt")]
    )
    return {"knowledge": files}


# ---------------------------------------------------------------------------
# 13. GET /api/knowledge/{name} — 读取知识文件
# ---------------------------------------------------------------------------
@app.get("/api/knowledge/{name}")
async def read_knowledge(name: str):
    fp = safe_knowledge_path(name)
    if not fp.exists():
        return {"error": "Knowledge file not found"}
    content = fp.read_text(encoding="utf-8")
    return {"name": fp.name, "content": content}


# ---------------------------------------------------------------------------
# 14. PUT /api/knowledge/{name} — 保存知识文件
# ---------------------------------------------------------------------------
@app.put("/api/knowledge/{name}")
async def save_knowledge(name: str, body: dict):
    fp = safe_knowledge_path(name)
    fp.write_text(body["content"], encoding="utf-8")
    return {"success": True}


# ---------------------------------------------------------------------------
# 15. GET /api/models — 模型配置列表
# ---------------------------------------------------------------------------
@app.get("/api/models")
async def list_models():
    result = []
    for f in sorted(MODELS_DIR.glob("*.yaml")):
        try:
            config = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except Exception:
            config = {}
        result.append({"name": f.name, "config": config})
    return {"models": result}


# ---------------------------------------------------------------------------
# 13. GET /api/models/{name} — 读取单个模型配置
# ---------------------------------------------------------------------------
@app.get("/api/models/{name}")
async def read_model(name: str):
    fp = safe_model_path(name)
    if not fp.exists():
        return {"error": "Model config not found"}
    content = fp.read_text(encoding="utf-8")
    try:
        config = yaml.safe_load(content) or {}
    except Exception:
        config = {}
    return {"name": name, "content": content, "config": config}


# ---------------------------------------------------------------------------
# 14. PUT /api/models/{name} — 保存模型配置
# ---------------------------------------------------------------------------
@app.put("/api/models/{name}")
async def save_model(name: str, body: dict):
    fp = safe_model_path(name)
    if "content" in body:
        fp.write_text(body["content"], encoding="utf-8")
    elif "config" in body:
        fp.write_text(
            yaml.dump(body["config"], allow_unicode=True, default_flow_style=False),
            encoding="utf-8",
        )
    else:
        return {"error": "Missing 'config' or 'content' field"}
    return {"success": True}


# ---------------------------------------------------------------------------
# 15. GET /api/export — 导出 Excel
# ---------------------------------------------------------------------------
@app.get("/api/export")
async def export_zip(model: str = Query(...)):
    db = SessionLocal()
    try:
        model = (model or "").strip()
        if not model:
            raise HTTPException(status_code=400, detail="model is required")

        rows = db.query(ExcelRow).order_by(ExcelRow.id).all()
        records = []
        for r in rows:
            data_dict = json.loads(r.data) if r.data else {}
            ann = (
                db.query(AnnotationResult)
                .filter(AnnotationResult.row_id == r.id, AnnotationResult.model_name == model)
                .first()
            )
            record = {
                "id": r.id,
                "file_name": r.file_name,
                "row_index": r.row_index,
                "human_answer": r.human_answer,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "annotation_model": model,
                "annotation_label": ann.label if ann else "",
                "annotation_match": ann.match_type if ann else "",
                "annotation_duration_ms": ann.duration_ms if ann else "",
                "annotation_duration": format_duration_ms(ann.duration_ms) if ann else "",
                "annotation_prompt_version": ann.prompt_version if ann else "",
                "annotation_created_at": ann.created_at.isoformat() if ann and ann.created_at else "",
            }
            record.update(data_dict)
            if ann:
                ann_result = json.loads(ann.result) if ann.result else {}
                for key, value in ann_result.items():
                    record[key] = value
            records.append(record)

        all_anns = (
            db.query(AnnotationResult)
            .filter(AnnotationResult.model_name == model)
            .order_by(AnnotationResult.id)
            .all()
        )
        ann_list = []
        for a in all_anns:
            ann_list.append({
                "id": a.id,
                "row_id": a.row_id,
                "model_name": a.model_name,
                "prompt_version": a.prompt_version,
                "result": json.loads(a.result) if a.result else {},
                "label": a.label,
                "match_type": a.match_type,
                "duration_ms": a.duration_ms,
                "duration": format_duration_ms(a.duration_ms),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            })

        total = db.query(ExcelRow).count()
        stats_payload = build_stats_payload(total, all_anns, model, [model])
        source_file_name = resolve_export_source_file_name(rows)

        export_meta = {
            "exported_at": datetime.utcnow().isoformat(),
            "row_count": total,
            "annotation_count": len(ann_list),
            "annotation_combination": model,
        }

        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            pd.DataFrame(records).to_excel(writer, sheet_name="标注数据", index=False)
            pd.DataFrame([stats_payload]).to_excel(writer, sheet_name="统计数据", index=False)
            pd.DataFrame(ann_list).to_excel(writer, sheet_name="标注明细", index=False)
            pd.DataFrame([export_meta]).to_excel(writer, sheet_name="导出信息", index=False)

        output.seek(0)
        filename = build_export_filename(model, stats_payload, source_file_name)
        ascii_fallback = "annotation_export.xlsx"
        encoded_filename = quote(filename)

        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="{ascii_fallback}"; '
                    f"filename*=UTF-8''{encoded_filename}"
                )
            },
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 16. DELETE /api/clear — 清理全部数据
# ---------------------------------------------------------------------------
@app.delete("/api/clear")
async def clear_all_data():
    """清理所有已入库的 Excel 数据和标注结果"""
    db = SessionLocal()
    try:
        task_ids = [r[0] for r in db.query(AnnotationTask.id).all()]
        task_count = db.query(AnnotationTask).count()
        db.query(AnnotationTask).delete()
        annotation_count = db.query(AnnotationResult).count()
        db.query(AnnotationResult).delete()
        row_count = db.query(ExcelRow).count()
        db.query(ExcelRow).delete()
        db.commit()
        forget_annotation_tasks(task_ids)
        return {
            "success": True,
            "message": f"已清理 {row_count} 条数据、{annotation_count} 条标注结果和 {task_count} 条标注任务",
        }
    except Exception as e:
        db.rollback()
        return {"success": False, "message": str(e)}
    finally:
        db.close()





# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=5001)
