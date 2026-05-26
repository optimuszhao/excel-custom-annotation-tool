"""
数据飞轮 Prompt 标注调试台 — FastAPI 后端
"""

from utils import render_prompt
import json
import math
import hashlib
import os
import random
import shutil
import tempfile
import time
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

import pandas as pd
import yaml
from fastapi import FastAPI, HTTPException, UploadFile, File, Query, Request, Body, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import or_, func, text, distinct

# 从 database 和 models 模块导入
from database import engine, SessionLocal, get_db, Base, BASE_DIR
from models import *
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
DATA_DIR = BASE_DIR / "data"

# ---------------------------------------------------------------------------
# 并发控制相关常量和锁
# ---------------------------------------------------------------------------
MAX_TASK_CONCURRENCY = 20
MAX_ACTIVE_TASKS_PER_COMBO = 10
TASK_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_TASK_CONCURRENCY)
TASK_ACTIVE_STATUSES = {"pending", "running"}
TASK_CREATE_LOCK = Lock()
TASK_SCHEDULER_LOCK = Lock()
TASK_RUNNING_IDS = set()
TASK_ACTIVE_BY_COMBO = defaultdict(int)
TASK_RECOVERY_STOP = Event()

# 内存维护：当前正在标注的行ID（替代 DB 持久化）—— 字典在此声明，锁在 threading import 后初始化
TASK_CURRENT_ROWS: Dict[str, set] = {}  # task_id → {row_id1, row_id2, ...}

# 全局标注并发信号量 - 最大 20 个并行标注 worker
import threading as _threading
GLOBAL_ANNOTATION_SEMAPHORE = _threading.Semaphore(20)
TASK_CURRENT_ROWS_LOCK = _threading.Lock()  # 保护 TASK_CURRENT_ROWS 的线程锁
TASK_RECOVERY_THREAD = None
TASK_STALE_RUNNING_SECONDS = 30 * 60

# ---------------------------------------------------------------------------
# 全局定时同步状态
# ---------------------------------------------------------------------------
SYNC_STATUS = {"status": "idle", "last_sync_time": None, "last_sync_result": None}
SYNC_TIMER = None
SYNC_INTERVAL_SECONDS = 3600  # 每小时同步一次
SYNC_LOCK = Lock()


# ---------------------------------------------------------------------------
# DB → 本地文件 全局定时同步
# ---------------------------------------------------------------------------
def _sync_all_db_to_local():
    """将 DB 中所有场景的 Prompt、知识、规则、错题本同步到本地文件"""
    global SYNC_STATUS
    with SYNC_LOCK:
        if SYNC_STATUS["status"] == "syncing":
            return  # 防止重复执行
        SYNC_STATUS["status"] = "syncing"

    results = {}
    db = SessionLocal()
    try:
        scenes = db.query(Scene).all()
        for scene in scenes:
            scene_name = scene.name
            scene_id = scene.id
            scene_results = {}

            # ---- Prompt 同步 ----
            try:
                prompts = db.query(Prompt).filter(Prompt.scene_id == scene_id).all()
                scene_prompt_dir = DATA_DIR / "prompts" / scene_name
                scene_prompt_dir.mkdir(parents=True, exist_ok=True)
                existing_files = set(f.name for f in scene_prompt_dir.glob("*.*"))
                synced_names = set()
                for p in prompts:
                    file_name = f"{p.name}{p.file_type or '.prompt'}"
                    file_path = scene_prompt_dir / file_name
                    file_path.write_text(p.content, encoding="utf-8")
                    synced_names.add(file_name)
                for f_name in existing_files - synced_names:
                    (scene_prompt_dir / f_name).unlink()
                scene_results["prompts"] = {"synced": len(prompts), "deleted": len(existing_files - synced_names)}
            except Exception as e:
                scene_results["prompts"] = {"error": str(e)}

            # ---- 知识同步 ----
            try:
                files = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).all()
                scene_dir = DATA_DIR / "knowledge" / scene_name
                scene_dir.mkdir(parents=True, exist_ok=True)
                synced_count = 0
                for kf in files:
                    file_name = kf.name if kf.name.endswith((".json", ".jsonl", ".txt")) else f"{kf.name}{kf.file_type or '.txt'}"
                    file_path = scene_dir / file_name
                    if not str(file_path.resolve()).startswith(str(scene_dir.resolve())):
                        continue
                    file_path.write_text(kf.content or "", encoding="utf-8")
                    synced_count += 1
                scene_results["knowledge"] = {"synced": synced_count}
            except Exception as e:
                scene_results["knowledge"] = {"error": str(e)}

            # ---- 规则同步 ----
            try:
                rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
                if rule:
                    rule_data = {
                        "annotate_fields": json.loads(rule.annotate_fields) if rule.annotate_fields else [],
                        "answer_field": rule.answer_field or "",
                        "result_label_field": rule.result_label_field or "",
                        "excel_fields": json.loads(rule.excel_fields) if rule.excel_fields else [],
                    }
                    rules_data_dir = BASE_DIR / "data" / "rules"
                    rules_data_dir.mkdir(parents=True, exist_ok=True)
                    rule_file_path = rules_data_dir / f"{scene_name}.json"
                    rule_file_path.write_text(
                        json.dumps(rule_data, ensure_ascii=False, indent=2),
                        encoding='utf-8'
                    )
                    scene_results["rules"] = {"synced": 1}
                else:
                    scene_results["rules"] = {"synced": 0, "reason": "无规则配置"}
            except Exception as e:
                scene_results["rules"] = {"error": str(e)}

            # ---- 错题本同步 ----
            try:
                errors = db.query(ErrorBook).filter(ErrorBook.scene_id == scene_id).all()
                error_dir = DATA_DIR / "error_books"
                error_dir.mkdir(parents=True, exist_ok=True)
                error_file_path = error_dir / f"{scene_name}_errors.jsonl"
                # 批量通过 row_id JOIN excel_rows 获取 original_data
                _eb_row_ids = [eb.row_id for eb in errors if eb.row_id]
                _eb_row_data_map = {}
                if _eb_row_ids:
                    for _er in db.query(ExcelRow).filter(ExcelRow.id.in_(_eb_row_ids)).all():
                        _eb_row_data_map[_er.id] = _er.data
                lines = []
                for eb in errors:
                    # 降级策略：有 row_id 走 JOIN，无 row_id 读 original_data
                    _od_source = _eb_row_data_map.get(eb.row_id) if eb.row_id else None
                    _od_raw = _od_source or eb.original_data
                    original_data = None
                    try:
                        original_data = json.loads(_od_raw) if _od_raw else None
                    except (json.JSONDecodeError, TypeError):
                        original_data = _od_raw
                    record = {
                        "id": eb.id,
                        "cot_name": eb.cot_name,
                        "original_data": original_data,
                        "expected_answer": eb.expected_answer,
                        "actual_output": eb.actual_output,
                        "error_reason": eb.error_reason,
                        "created_at": eb.created_at.isoformat() if eb.created_at else None,
                    }
                    lines.append(json.dumps(record, ensure_ascii=False))
                error_file_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
                scene_results["error_books"] = {"synced": len(errors)}
            except Exception as e:
                scene_results["error_books"] = {"error": str(e)}

            results[scene_name] = scene_results
    except Exception as e:
        results["_global_error"] = str(e)
    finally:
        db.close()

    with SYNC_LOCK:
        SYNC_STATUS["status"] = "done"
        SYNC_STATUS["last_sync_time"] = datetime.utcnow().isoformat()
        SYNC_STATUS["last_sync_result"] = results

    # 5秒后自动恢复为 idle
    def _reset_to_idle():
        with SYNC_LOCK:
            if SYNC_STATUS["status"] == "done":
                SYNC_STATUS["status"] = "idle"
    _threading.Timer(5, _reset_to_idle).start()


def _schedule_sync_timer():
    """调度下一次定时同步"""
    global SYNC_TIMER
    SYNC_TIMER = _threading.Timer(SYNC_INTERVAL_SECONDS, _sync_timer_tick)
    SYNC_TIMER.daemon = True
    SYNC_TIMER.start()


def _sync_timer_tick():
    """定时同步触发回调"""
    try:
        _sync_all_db_to_local()
    except Exception as e:
        print(f"[SyncTimer] 定时同步异常: {e}")
    finally:
        _schedule_sync_timer()  # 无论成功失败，继续调度下一轮


def start_sync_scheduler():
    """启动定时同步调度器"""
    print(f"[SyncScheduler] 启动，间隔 {SYNC_INTERVAL_SECONDS} 秒")
    _schedule_sync_timer()


def stop_sync_scheduler():
    """停止定时同步调度器"""
    global SYNC_TIMER
    if SYNC_TIMER:
        SYNC_TIMER.cancel()
        SYNC_TIMER = None
    print("[SyncScheduler] 已停止")


# ---------------------------------------------------------------------------
# 标注调度器
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
    # 创建所有目录
    for d in [UPLOADS_DIR, PROMPTS_DIR, KNOWLEDGE_DIR, MODELS_DIR, CONFIG_DIR,
              TEMPLATES_DIR, STATIC_DIR, DATA_DIR,
              DATA_DIR / "datasets", DATA_DIR / "prompts", DATA_DIR / "knowledge",
              DATA_DIR / "rules", DATA_DIR / "error_books", DATA_DIR / "exports"]:
        d.mkdir(parents=True, exist_ok=True)
    # 创建所有数据库表
    Base.metadata.create_all(bind=engine)
    # 数据库迁移：为 prompts 表添加 role_name 列
    try:
        with engine.connect() as conn:
            result = conn.execute(text("PRAGMA table_info(prompts)"))
            columns = [row[1] for row in result.fetchall()]
            if 'role_name' not in columns:
                conn.execute(text("ALTER TABLE prompts ADD COLUMN role_name TEXT DEFAULT NULL"))
                conn.commit()
    except Exception as e:
        print(f"[DB Migration] prompts.role_name: {e}")
    # 数据库迁移：为 excel_files 表添加 annotate_config 列
    try:
        with engine.connect() as conn:
            result = conn.execute(text("PRAGMA table_info(excel_files)"))
            columns = [row[1] for row in result.fetchall()]
            if 'annotate_config' not in columns:
                conn.execute(text("ALTER TABLE excel_files ADD COLUMN annotate_config TEXT DEFAULT NULL"))
                conn.commit()
    except Exception as e:
        print(f"[DB Migration] excel_files.annotate_config: {e}")
    # 数据库迁移：将 annotation_tasks.current_row_id 从 INTEGER 升级为 TEXT（支持 JSON 数组存储并行标注的多个行ID）
    try:
        with engine.connect() as conn:
            result = conn.execute(text("PRAGMA table_info(annotation_tasks)"))
            col_info = {row[1]: row[2] for row in result.fetchall()}
            current_type = col_info.get('current_row_id', '').upper()
            if 'current_row_id' not in col_info:
                # 列不存在，直接添加 TEXT 类型
                conn.execute(text("ALTER TABLE annotation_tasks ADD COLUMN current_row_id TEXT DEFAULT NULL"))
                conn.commit()
            elif current_type == 'INTEGER':
                # 列存在但是 INTEGER，需要迁移为 TEXT
                # SQLite 不支持 ALTER COLUMN，用临时列方案迁移
                conn.execute(text("ALTER TABLE annotation_tasks ADD COLUMN current_row_id_text TEXT DEFAULT NULL"))
                conn.execute(text("UPDATE annotation_tasks SET current_row_id_text = CAST(current_row_id AS TEXT) WHERE current_row_id IS NOT NULL"))
                # SQLite 无法删列，直接用新列名覆盖旧列策略（保留旧列用于兼容）
                conn.commit()
                print("[DB Migration] annotation_tasks.current_row_id 升级完成（INTEGER -> TEXT）")
    except Exception as e:
        print(f"[DB Migration] annotation_tasks.current_row_id 升级: {e}")
    # DB Migration: annotation_results 唯一约束
    try:
        with engine.connect() as conn:
            existing_indexes = conn.execute(text("PRAGMA index_list(annotation_results)")).fetchall()
            index_names = [row[1] for row in existing_indexes]
            if "uq_task_row_prompt" not in index_names:
                conn.execute(text("""
                    DELETE FROM annotation_results
                    WHERE id NOT IN (
                        SELECT MAX(id) FROM annotation_results
                        GROUP BY task_id, row_id, prompt_name
                    )
                """))
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_task_row_prompt "
                    "ON annotation_results(task_id, row_id, prompt_name)"
                ))
                conn.commit()
                print("[DB Migration] annotation_results 唯一约束创建完成")
    except Exception as e:
        print(f"[DB Migration] annotation_results 唯一约束迁移异常: {e}")
    # 初始化默认场景和规则
    init_default_scene_and_rules()
    # 启动时扫描本地文件并同步到数据库
    scan_and_sync_local_files()
    # 启动标注调度器
    start_annotation_scheduler()
    # 启动定时同步调度器
    start_sync_scheduler()
    try:
        yield
    finally:
        stop_annotation_scheduler()
        stop_sync_scheduler()


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


# ---------------------------------------------------------------------------
# 页面路由
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"request": request, "active_page": "excel"})


@app.get("/workbench", response_class=HTMLResponse)
async def workbench(request: Request):
    return templates.TemplateResponse(request=request, name="workbench.html", context={"active_page": "workbench"})


@app.get("/prompt-manage", response_class=HTMLResponse)
async def prompt_manage(request: Request):
    return templates.TemplateResponse(request=request, name="prompt_manage.html", context={"active_page": "prompt"})


@app.get("/knowledge-manage", response_class=HTMLResponse)
async def knowledge_manage(request: Request):
    return templates.TemplateResponse(request=request, name="knowledge_manage.html", context={"active_page": "knowledge"})


@app.get("/rule-config", response_class=HTMLResponse)
async def rule_config(request: Request):
    return templates.TemplateResponse(request=request, name="rule_config.html", context={"active_page": "rule"})


@app.get("/error-book", response_class=HTMLResponse)
async def error_book(request: Request):
    return templates.TemplateResponse(request=request, name="error_book.html", context={"active_page": "error_book"})


@app.get("/model-chat", response_class=HTMLResponse)
async def model_chat_page(request: Request):
    return templates.TemplateResponse(request=request, name="model_chat.html", context={"active_page": "chat"})


@app.get("/statistics", response_class=HTMLResponse)
async def statistics_page(request: Request):
    return templates.TemplateResponse(request=request, name="statistics.html", context={"active_page": "statistics"})


@app.get("/task-manage", response_class=HTMLResponse)
async def task_manage(request: Request):
    return templates.TemplateResponse(request=request, name="task_manage.html", context={"request": request, "active_page": "workbench"})


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def safe_prompt_path(name: str) -> Path:
    """校验 Prompt 文件名安全性，防止目录遍历"""
    pure_name = Path(name).name
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


def upsert_annotation_result(db, task_id, row_id: int, prompt_name: str, **kwargs):
    """
    UPSERT AnnotationResult：存在则更新，不存在则插入。
    task_id 为 None 时用 '__legacy__' 代替。
    prompt_name 为 None 时用 '__default__' 代替。
    """
    safe_task_id = task_id if task_id is not None else "__legacy__"
    safe_prompt_name = prompt_name if prompt_name is not None else "__default__"
    existing = db.query(AnnotationResult).filter(
        AnnotationResult.task_id == safe_task_id,
        AnnotationResult.row_id == row_id,
        AnnotationResult.prompt_name == safe_prompt_name,
    ).first()
    if existing:
        for key, value in kwargs.items():
            if hasattr(existing, key):
                setattr(existing, key, value)
        return existing
    else:
        obj = AnnotationResult(
            task_id=safe_task_id,
            row_id=row_id,
            prompt_name=safe_prompt_name,
            **kwargs,
        )
        db.add(obj)
        return obj


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


def calc_task_stats(task_id: str, db) -> dict:
    """从 AnnotationResult 动态聚合任务统计指标"""
    # 优先使用 __merged__ 结果（多 Prompt 场景避免重复计数）
    results = db.query(AnnotationResult).filter(
        AnnotationResult.task_id == task_id,
        AnnotationResult.match_type.isnot(None),
        AnnotationResult.prompt_name == "__merged__",
    ).all()
    # 降级：没有 __merged__ 则使用单 prompt 结果（排除 __error__）
    if not results:
        results = db.query(AnnotationResult).filter(
            AnnotationResult.task_id == task_id,
            AnnotationResult.match_type.isnot(None),
            AnnotationResult.prompt_name != "__error__",
        ).all()
    tp = sum(1 for r in results if r.match_type == "TP")
    fn = sum(1 for r in results if r.match_type == "FN")
    fp = sum(1 for r in results if r.match_type == "FP")
    tn = sum(1 for r in results if r.match_type == "TN")
    unknown = sum(1 for r in results if r.match_type not in ("TP", "FN", "FP", "TN"))
    valid = len(results) - unknown
    return {
        "accuracy": ratio(tp + tn, valid),
        "recall": ratio(tp, tp + fn),
        "precision": ratio(tp, tp + fp),
        "f1_score": ratio(2 * tp, 2 * tp + fp + fn),
    }


def format_percent_ratio(value: Optional[float]) -> str:
    if value is None:
        return "0%"
    return f"{value * 100:.1f}%"


def split_combo_name(combo_name: str) -> tuple:
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


def resolve_export_source_file_name(rows: list, db=None) -> str:
    """通过 file_id JOIN excel_files 获取文件名，降级读取 row.file_name"""
    file_ids = list({r.file_id for r in rows if r.file_id})
    file_name_map = {}
    if db and file_ids:
        excel_files = db.query(ExcelFile).filter(ExcelFile.id.in_(file_ids)).all()
        file_name_map = {ef.id: ef.file_name for ef in excel_files}
    names = []
    for row in rows:
        name = (file_name_map.get(row.file_id, "") or row.file_name or "").strip()
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


def rest_ir(prompt: str, row_data: dict, model_config_name: str, strategy_name: str = "方案A",
            prompt_list: list = None, concurrency: int = 1, knowledge_list: list = None) -> dict:
    """
    调用大模型标注接口 — 根据策略名调用对应的标注方案
    """
    strategy_fn = STRATEGIES.get(strategy_name)
    if not strategy_fn:
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


def annotate_one_row(row_data: dict, model_config_name: str, prompts: Any,
                     strategy_name: str = "方案A", concurrency: int = 1, knowledge: Any = None) -> dict:
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


def annotate_rows_concurrently(valid_items: list, model_config_name: str, prompts: Any,
                                strategy_name: str, concurrency: int) -> list:
    """
    并发调用单条标注入口。
    """
    if not valid_items:
        return []

    max_workers = min(max(1, concurrency), len(valid_items))

    def run_one(item: dict) -> dict:
        row_id = item["row_id"]
        try:
            # 行级并发由 ThreadPoolExecutor 保证，单行内部不做并发
            result = annotate_one_row(item["data"], model_config_name, prompts, strategy_name, concurrency=1)
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
            # 只减少超时任务对应的 combo 计数（不要 clear 全部）
            for task in running_tasks:
                if task.id in stale_ids and task.model_name:
                    TASK_ACTIVE_BY_COMBO[task.model_name] = max(0,
                        TASK_ACTIVE_BY_COMBO.get(task.model_name, 0) - 1)
                    if TASK_ACTIVE_BY_COMBO.get(task.model_name, 0) == 0:
                        TASK_ACTIVE_BY_COMBO.pop(task.model_name, None)
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
    """旧版单行标注入口，已弃用。新任务统一走 execute_workbench_annotation_task。"""
    # 兼容旧格式任务：若 row_data 不是列表格式且 row_id 有值，转为列表格式
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            return
        if task.row_id and task.row_data:
            try:
                parsed = json.loads(task.row_data)
                if not isinstance(parsed, list):
                    task.row_data = json.dumps([task.row_id])
                    db.commit()
            except (json.JSONDecodeError, TypeError):
                task.row_data = json.dumps([task.row_id])
                db.commit()
        elif task.row_id and not task.row_data:
            task.row_data = json.dumps([task.row_id])
            db.commit()
    finally:
        db.close()
    # 委托给新版执行器
    execute_workbench_annotation_task(task_id)


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
        "model_name": task.model_name,
        "model_config": task.model_config,
        "strategy": task.strategy,
        "concurrency": task.concurrency,
        "status": task.status,
        "error": task.error,
        "duration_ms": task.duration_ms,
        "duration_text": format_duration_ms(task.duration_ms),
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "finished_at": task.finished_at.isoformat() if task.finished_at else None,
    }


# ---------------------------------------------------------------------------
# Rule / Settings 配置
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


# ---------------------------------------------------------------------------
# API — Settings
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# API — Rule 配置
# ---------------------------------------------------------------------------
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


@app.put("/api/rule/display-columns")
async def save_display_columns_to_rule(request: Request):
    """将当前显示列配置保存到 rule.json 的 excel_fields，同步更新数据库"""
    body = await request.json()
    columns = body.get("columns", [])
    scene_id = body.get("scene_id")
    if not isinstance(columns, list):
        raise HTTPException(status_code=400, detail="columns 必须是数组")

    rule_path = CONFIG_DIR / "rule.json"
    with open(rule_path, "r", encoding="utf-8") as f:
        rule = json.load(f)

    rule["excel_fields"] = columns

    with open(rule_path, "w", encoding="utf-8") as f:
        json.dump(rule, f, ensure_ascii=False, indent=2)

    # 同步更新数据库中对应场景的 RuleConfig
    if scene_id:
        db = SessionLocal()
        try:
            scene_name_for_file = None
            scene_obj = db.query(Scene).filter(Scene.id == scene_id).first()
            if scene_obj:
                scene_name_for_file = scene_obj.name

            # NULL 防护：scene_id 非空时用 == 过滤
            rule_config = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
            if rule_config:
                rule_config.excel_fields = json.dumps(columns, ensure_ascii=False)
                rule_config.updated_at = datetime.utcnow()
            else:
                rule_config = RuleConfig(
                    scene_id=scene_id,
                    excel_fields=json.dumps(columns, ensure_ascii=False),
                    annotate_fields="[]",
                    answer_field="",
                    result_label_field="",
                )
                db.add(rule_config)
            db.commit()

            # 同步写入 data/rules/{scene_name}.json 的 excel_fields
            if scene_name_for_file:
                rules_data_dir = DATA_DIR / "rules"
                rules_data_dir.mkdir(parents=True, exist_ok=True)
                rule_file = rules_data_dir / f"{scene_name_for_file}.json"
                if rule_file.exists():
                    with open(rule_file, "r", encoding="utf-8") as f:
                        existing_data = json.load(f)
                else:
                    existing_data = {"annotate_fields": [], "answer_field": "", "result_label_field": ""}
                existing_data["excel_fields"] = columns
                rule_file.write_text(json.dumps(existing_data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:
            db.rollback()
            print(f"[warn] 同步 display-columns 到数据库失败: {e}")
        finally:
            db.close()

    return {"success": True, "excel_fields": columns}


# ---------------------------------------------------------------------------
# API — Excel 上传 & 数据行
# ---------------------------------------------------------------------------
@app.post("/api/upload")
async def upload_excel(file: UploadFile = File(...)):
    content = await file.read()
    df = read_uploaded_content(file.filename, content)
    columns = df.columns.tolist()
    imported = import_dataframe(file.filename, df)
    return {"columns": columns, "filename": file.filename, "imported": imported}


@app.post("/api/import")
async def import_data(body: dict):
    raise HTTPException(status_code=410, detail="Import from saved upload is disabled; use /api/upload")


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
        # 通过子查询 JOIN excel_files 搜索文件名
        _ef_ids_subq = db.query(ExcelFile.id).filter(ExcelFile.file_name.contains(search)).subquery()
        search_conditions = [
            ExcelRow.data.contains(search),
            ExcelRow.human_answer.contains(search),
            ExcelRow.file_id.in_(_ef_ids_subq),
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
            # 通过子查询 JOIN excel_files 搜索文件名
            _ef_ids_subq = db.query(ExcelFile.id).filter(ExcelFile.file_name.contains(search)).subquery()
            search_conditions = [
                ExcelRow.data.contains(search),
                ExcelRow.human_answer.contains(search),
                ExcelRow.file_id.in_(_ef_ids_subq),
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
                "results": annotations,
                "match_type": row_match_type,
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
# API — 字段配置
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
# API — 统计
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
# API — 标注
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
                    model_name=model_name,
                    model_config=model_config_name,
                    strategy=strategy_name,
                    concurrency=concurrency,
                    row_data=json.dumps([row_id], ensure_ascii=False),
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
            # 计算真实 match_type
            db_row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
            match_type = calc_match_type(db_row.human_answer if db_row else "", label)
            existing = existing_by_row.get(row_id)
            if existing:
                existing.prompt_version = "custom_full_dataset_mock"
                existing.result = result_json
                existing.label = label
                existing.match_type = match_type
                existing.duration_ms = row_duration_ms
                existing.created_at = finished
            else:
                upsert_annotation_result(
                    db,
                    task_id=None,
                    row_id=row_id,
                    prompt_name=None,
                    model_name=model_name,
                    prompt_version="custom_full_dataset_mock",
                    result=result_json,
                    label=label,
                    match_type=match_type,
                    duration_ms=row_duration_ms,
                    created_at=finished,
                )

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

        # 通过 AnnotationResult 桥接查找关联的任务ID（已废弃 task.row_id，改用 result 表关联）
        task_ids = [
            r[0] for r in db.query(AnnotationResult.task_id)
            .filter(AnnotationResult.row_id.in_(existing_ids))
            .distinct().all()
        ]

        active_count = (
            db.query(AnnotationTask)
            .filter(
                AnnotationTask.id.in_(task_ids),
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

        annotation_count = db.query(AnnotationResult).filter(
            AnnotationResult.row_id.in_(existing_ids)
        ).delete(synchronize_session=False)
        task_count = db.query(AnnotationTask).filter(
            AnnotationTask.id.in_(task_ids)
        ).delete(synchronize_session=False) if task_ids else 0
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


# ---------------------------------------------------------------------------
# API — 标注任务管理
# ---------------------------------------------------------------------------
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
        if active_only:
            query = query.filter(AnnotationTask.status.in_(list(TASK_ACTIVE_STATUSES)))
        # 按行ID筛选：通过 AnnotationResult 桥接查找关联任务
        if ids:
            bridged_task_ids = [
                r[0] for r in db.query(AnnotationResult.task_id)
                .filter(AnnotationResult.row_id.in_(ids))
                .distinct().all()
            ]
            if bridged_task_ids:
                query = query.filter(AnnotationTask.id.in_(bridged_task_ids))
            else:
                # 无匹配任务，返回空列表
                return {"tasks": []}
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
# 启动时扫描本地文件并同步到数据库
# ---------------------------------------------------------------------------
def scan_and_sync_local_files():
    """启动时扫描 data/ 目录，将本地文件同步到数据库（本地为权威源）"""
    db = SessionLocal()
    try:
        # --- 扫描 data/datasets/：按场景子目录导入 Excel 文件 ---
        datasets_dir = BASE_DIR / "data" / "datasets"
        if datasets_dir.exists():
            for scene_dir in datasets_dir.iterdir():
                if not scene_dir.is_dir():
                    continue
                scene_name = scene_dir.name
                # 场景不存在则跳过
                scene = db.query(Scene).filter(Scene.name == scene_name).first()
                if not scene:
                    print(f"⚠ 数据集目录 {scene_name} 对应场景不存在，跳过")
                    continue

                for excel_file in scene_dir.glob("*.xlsx"):
                    # 检查文件是否已入库（按 scene_id + file_path 去重）
                    already_imported = db.query(ExcelFile).filter(
                        ExcelFile.scene_id == scene.id,
                        ExcelFile.file_path == str(excel_file)
                    ).first()
                    if already_imported:
                        continue  # 已入库则跳过

                    # 新文件：自动导入
                    try:
                        df = pd.read_excel(excel_file)
                        # 读取该场景的 answer_field 用于统计已标注行数
                        rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene.id).first()
                        answer_field = rule.answer_field if rule else ""

                        excel_record = ExcelFile(
                            file_name=excel_file.name,
                            original_file_name=excel_file.name,
                            scene_id=scene.id,
                            total_rows=len(df),
                            annotated_count=int(df[answer_field].notna().sum()) if answer_field in df.columns else 0,
                            columns_info=json.dumps(list(df.columns), ensure_ascii=False),
                            file_path=str(excel_file),
                        )
                        db.add(excel_record)
                        db.flush()  # 获取 excel_record.id

                        for row_idx, row in df.iterrows():
                            # 将 NaN 转为 None，保证 JSON 序列化正常
                            row_dict = {
                                col: (None if pd.isna(row[col]) else row[col])
                                for col in df.columns
                            }
                            human_answer = row_dict.get(answer_field)
                            if human_answer is not None:
                                human_answer = str(human_answer).strip()
                            db.add(ExcelRow(
                                file_id=excel_record.id,
                                row_index=int(row_idx) + 1,
                                data=json.dumps(row_dict, ensure_ascii=False, default=str),
                                human_answer=human_answer,
                            ))
                        print(f"✓ 自动导入 Excel: {excel_file} ({len(df)} 行)")
                    except Exception as import_err:
                        print(f"⚠ 导入 {excel_file} 失败: {import_err}")

        # --- 扫描 data/prompts/：按场景子目录同步 Prompt 文件 ---
        prompts_data_dir = BASE_DIR / "data" / "prompts"
        if prompts_data_dir.exists():
            for scene_dir in prompts_data_dir.iterdir():
                if not scene_dir.is_dir():
                    continue
                scene = db.query(Scene).filter(Scene.name == scene_dir.name).first()
                if not scene:
                    continue
                for prompt_file in scene_dir.iterdir():
                    if prompt_file.suffix not in ('.prompt', '.txt'):
                        continue
                    existing_prompt = db.query(Prompt).filter(
                        Prompt.scene_id == scene.id,
                        Prompt.name == prompt_file.stem
                    ).first()
                    local_content = prompt_file.read_text(encoding='utf-8')
                    if not existing_prompt:
                        # 新 Prompt：入库
                        db.add(Prompt(
                            scene_id=scene.id,
                            name=prompt_file.stem,
                            content=local_content,
                            file_type=prompt_file.suffix,
                        ))
                    elif existing_prompt.content != local_content:
                        # 本地文件有更新：以本地为准覆盖 DB
                        existing_prompt.content = local_content
                        existing_prompt.updated_at = datetime.utcnow()

        # --- 扫描 data/knowledge/：按场景子目录同步知识文件 ---
        knowledge_data_dir = BASE_DIR / "data" / "knowledge"
        if knowledge_data_dir.exists():
            for scene_dir in knowledge_data_dir.iterdir():
                if not scene_dir.is_dir():
                    continue
                scene = db.query(Scene).filter(Scene.name == scene_dir.name).first()
                if not scene:
                    continue
                for knowledge_file in scene_dir.iterdir():
                    if knowledge_file.suffix not in ('.json', '.jsonl', '.txt'):
                        continue
                    existing_knowledge = db.query(KnowledgeFile).filter(
                        KnowledgeFile.scene_id == scene.id,
                        KnowledgeFile.name == knowledge_file.name
                    ).first()
                    local_content = knowledge_file.read_text(encoding='utf-8')
                    if not existing_knowledge:
                        # 新知识文件：入库
                        db.add(KnowledgeFile(
                            scene_id=scene.id,
                            name=knowledge_file.name,
                            content=local_content,
                            file_type=knowledge_file.suffix,
                        ))
                    elif existing_knowledge.content != local_content:
                        # 本地文件有更新：以本地为准覆盖 DB
                        existing_knowledge.content = local_content
                        existing_knowledge.updated_at = datetime.utcnow()

        # --- 扫描 data/rules/：按场景名 JSON 文件同步规则配置 ---
        rules_data_dir = BASE_DIR / "data" / "rules"
        if rules_data_dir.exists():
            for rule_json_file in rules_data_dir.glob("*.json"):
                scene_name = rule_json_file.stem
                scene = db.query(Scene).filter(Scene.name == scene_name).first()
                if not scene:
                    continue
                try:
                    rule_data = json.loads(rule_json_file.read_text(encoding='utf-8'))
                except Exception as parse_err:
                    print(f"⚠ 解析规则文件 {rule_json_file} 失败: {parse_err}")
                    continue

                # NULL 防护：scene.id 非空，但仍需二次确认防并发
                existing_rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene.id).first()
                if not existing_rule:
                    # 新规则：入库
                    db.add(RuleConfig(
                        scene_id=scene.id,
                        annotate_fields=json.dumps(rule_data.get("annotate_fields", []), ensure_ascii=False),
                        answer_field=rule_data.get("answer_field", ""),
                        result_label_field=rule_data.get("result_label_field", ""),
                        excel_fields=json.dumps(rule_data.get("excel_fields", []), ensure_ascii=False),
                    ))
                else:
                    # 本地文件为权威源，更新 DB
                    existing_rule.annotate_fields = json.dumps(rule_data.get("annotate_fields", []), ensure_ascii=False)
                    existing_rule.answer_field = rule_data.get("answer_field", "")
                    existing_rule.result_label_field = rule_data.get("result_label_field", "")
                    existing_rule.excel_fields = json.dumps(rule_data.get("excel_fields", []), ensure_ascii=False)
                    existing_rule.updated_at = datetime.utcnow()

        db.commit()
        print("✓ 启动扫描本地文件完成")

        # --- 补全历史文件的 COT 名称 ---
        try:
            files_need_cot = db.query(ExcelFile).filter(
                (ExcelFile.cot_names == None) | (ExcelFile.cot_names == '') | (ExcelFile.cot_names == '[]')
            ).all()
            updated_count = 0
            for excel_file in files_need_cot:
                if not excel_file.file_path or not os.path.exists(excel_file.file_path):
                    continue
                try:
                    df = pd.read_excel(excel_file.file_path)
                    cot_column = None
                    for col in df.columns:
                        if col.strip().lower() == 'cot名称':
                            cot_column = col
                            break
                    if cot_column:
                        cot_names_list = df[cot_column].dropna().astype(str).str.strip().unique().tolist()
                        cot_names_list = [name for name in cot_names_list if name]
                        if cot_names_list:
                            excel_file.cot_names = json.dumps(cot_names_list, ensure_ascii=False)
                            updated_count += 1
                except Exception:
                    continue
            db.commit()
            if updated_count > 0:
                print(f"✓ 补全历史文件 COT 名称: 更新了 {updated_count} 个文件")
        except Exception as cot_err:
            db.rollback()
            print(f"⚠ 补全历史文件 COT 名称异常: {cot_err}")
    except Exception as scan_err:
        db.rollback()
        print(f"⚠ 启动扫描异常: {scan_err}")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 初始化默认场景
# ---------------------------------------------------------------------------
def init_default_scene_and_rules():
    """若 scenes 表为空，创建 SPN 默认场景及其规则配置"""
    db = SessionLocal()
    try:
        scene_count = db.query(Scene).count()
        if scene_count > 0:
            return
        # 创建 SPN 默认场景
        default_scene = Scene(name="SPN", description="默认SPN场景")
        db.add(default_scene)
        db.flush()  # 获取 scene.id
        # 创建默认规则配置（来自 config/rule.json），先检查是否已存在防重复
        default_rule = load_rule()
        existing_rc = db.query(RuleConfig).filter(RuleConfig.scene_id == default_scene.id).first()
        if existing_rc:
            existing_rc.annotate_fields = json.dumps(
                default_rule.get("annotate_fields", []), ensure_ascii=False
            )
            existing_rc.answer_field = default_rule.get("answer_field", "人工标注答案")
            existing_rc.result_label_field = default_rule.get("result_label_field", "大模型标注答案")
            existing_rc.excel_fields = json.dumps(
                default_rule.get("excel_fields", []), ensure_ascii=False
            )
            existing_rc.updated_at = datetime.utcnow()
        else:
            rule_config = RuleConfig(
                scene_id=default_scene.id,
                annotate_fields=json.dumps(
                    default_rule.get("annotate_fields", []), ensure_ascii=False
                ),
                answer_field=default_rule.get("answer_field", "人工标注答案"),
                result_label_field=default_rule.get("result_label_field", "大模型标注答案"),
                excel_fields=json.dumps(
                    default_rule.get("excel_fields", []), ensure_ascii=False
                ),
            )
            db.add(rule_config)
        db.commit()
        print("[init] 已创建默认SPN场景及规则配置")
    except Exception as exc:
        db.rollback()
        print(f"[init] 创建默认场景失败: {exc}")
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 场景管理
# ---------------------------------------------------------------------------
@app.get("/api/scenes")
async def list_scenes():
    """返回所有场景列表"""
    db = SessionLocal()
    try:
        scenes = db.query(Scene).order_by(Scene.id.asc()).all()
        return [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description or "",
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in scenes
        ]
    finally:
        db.close()


@app.post("/api/scenes")
async def create_scene(request: Request):
    """新增场景"""
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="场景名称不能为空")
    description = (body.get("description") or "").strip()
    db = SessionLocal()
    try:
        existing = db.query(Scene).filter(Scene.name == name).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"场景名称 '{name}' 已存在")
        scene = Scene(name=name, description=description or None)
        db.add(scene)
        db.commit()
        db.refresh(scene)
        return {
            "id": scene.id,
            "name": scene.name,
            "description": scene.description or "",
            "created_at": scene.created_at.isoformat() if scene.created_at else None,
            "updated_at": scene.updated_at.isoformat() if scene.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/scenes/{scene_id}")
async def update_scene(scene_id: int, request: Request):
    """修改场景"""
    body = await request.json()
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")
        name = body.get("name")
        if name is not None:
            name = name.strip()
            if not name:
                raise HTTPException(status_code=400, detail="场景名称不能为空")
            # 检查名称是否与其他场景冲突
            conflict = db.query(Scene).filter(Scene.name == name, Scene.id != scene_id).first()
            if conflict:
                raise HTTPException(status_code=400, detail=f"场景名称 '{name}' 已被使用")
            scene.name = name
        description = body.get("description")
        if description is not None:
            scene.description = description.strip() or None
        db.commit()
        db.refresh(scene)
        return {
            "id": scene.id,
            "name": scene.name,
            "description": scene.description or "",
            "created_at": scene.created_at.isoformat() if scene.created_at else None,
            "updated_at": scene.updated_at.isoformat() if scene.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/scenes/{scene_id}")
async def delete_scene(scene_id: int):
    """删除场景（检查关联资源）"""
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")
        # 检查是否有关联资源
        related_info = []
        excel_count = db.query(ExcelFile).filter(ExcelFile.scene_id == scene_id).count()
        if excel_count > 0:
            related_info.append(f"{excel_count}个Excel文件")
        prompt_count = db.query(Prompt).filter(Prompt.scene_id == scene_id).count()
        if prompt_count > 0:
            related_info.append(f"{prompt_count}个Prompt")
        knowledge_count = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).count()
        if knowledge_count > 0:
            related_info.append(f"{knowledge_count}个知识文件")
        task_count = db.query(AnnotationTask).filter(AnnotationTask.scene_id == scene_id).count()
        if task_count > 0:
            related_info.append(f"{task_count}个标注任务")
        if related_info:
            raise HTTPException(
                status_code=409,
                detail=f"该场景下存在关联资源（{'，'.join(related_info)}），请先清除后再删除",
            )
        # 删除关联的规则配置
        db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).delete()
        db.delete(scene)
        db.commit()
        return {"success": True, "message": f"场景 '{scene.name}' 已删除"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 规则配置（按场景）
# ---------------------------------------------------------------------------
@app.get("/api/rules/{scene_id}")
async def get_rule_by_scene(scene_id: int):
    """获取场景规则配置，若无则返回默认空配置"""
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")
        rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
        if not rule:
            return {
                "scene_id": scene_id,
                "annotate_fields": [],
                "answer_field": "",
                "result_label_field": "",
                "excel_fields": [],
            }
        return {
            "scene_id": scene_id,
            "annotate_fields": json.loads(rule.annotate_fields) if rule.annotate_fields else [],
            "answer_field": rule.answer_field or "",
            "result_label_field": rule.result_label_field or "",
            "excel_fields": json.loads(rule.excel_fields) if rule.excel_fields else [],
        }
    finally:
        db.close()


@app.put("/api/rules/{scene_id}")
async def save_rule_by_scene(scene_id: int, request: Request):
    """更新场景规则配置，支持 JSON 字符串输入，同步写入数据库与本地文件"""
    body = await request.json()
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")

        # 优先从 json_text 字段解析（JSON 编辑器模式）
        json_text = body.get("json_text")
        if json_text is not None:
            try:
                parsed = json.loads(json_text)
            except json.JSONDecodeError as e:
                raise HTTPException(status_code=400, detail=f"JSON 格式不合法：{e}")
        else:
            # 兼容旧版表单模式（直接传字段对象）
            parsed = body

        annotate_fields = parsed.get("annotate_fields", [])
        answer_field = (parsed.get("answer_field") or "").strip()
        result_label_field = (parsed.get("result_label_field") or "").strip()
        excel_fields = parsed.get("excel_fields", [])

        # NULL 防护：scene_id 为 None 时 SQL = NULL 不匹配，需用 is_(None)
        if scene_id is None:
            rule = db.query(RuleConfig).filter(RuleConfig.scene_id.is_(None)).first()
        else:
            rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
        if rule:
            rule.annotate_fields = json.dumps(annotate_fields, ensure_ascii=False)
            rule.answer_field = answer_field or None
            rule.result_label_field = result_label_field or None
            rule.excel_fields = json.dumps(excel_fields, ensure_ascii=False)
            rule.updated_at = datetime.utcnow()
        else:
            rule = RuleConfig(
                scene_id=scene_id,
                annotate_fields=json.dumps(annotate_fields, ensure_ascii=False),
                answer_field=answer_field or None,
                result_label_field=result_label_field or None,
                excel_fields=json.dumps(excel_fields, ensure_ascii=False),
            )
            db.add(rule)
        db.commit()

        # 同步写入 data/rules/{scene_name}.json
        rule_file_data = {
            "excel_fields": excel_fields,
            "annotate_fields": annotate_fields,
            "answer_field": answer_field,
            "result_label_field": result_label_field,
        }
        for k, v in parsed.items():
            if k not in rule_file_data:
                rule_file_data[k] = v
        rules_data_dir = DATA_DIR / "rules"
        rules_data_dir.mkdir(parents=True, exist_ok=True)
        rule_path = rules_data_dir / f"{scene.name}.json"
        rule_path.write_text(json.dumps(rule_file_data, ensure_ascii=False, indent=2), encoding="utf-8")

        return {
            "success": True,
            "scene_id": scene_id,
            "annotate_fields": annotate_fields,
            "answer_field": answer_field,
            "result_label_field": result_label_field,
            "excel_fields": excel_fields,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/rules/sync-local")
async def sync_rule_to_local(request: Request):
    """将指定场景的规则配置写入 data/rules/{场景名}.json（DB 数据落盘到本地）"""
    body = await request.json()
    scene_id = body.get("scene_id")
    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")

    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")

        rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
        if not rule:
            raise HTTPException(status_code=404, detail="该场景尚未配置规则")

        # 构造规则数据字典
        rule_data = {
            "annotate_fields": json.loads(rule.annotate_fields) if rule.annotate_fields else [],
            "answer_field": rule.answer_field or "",
            "result_label_field": rule.result_label_field or "",
            "excel_fields": json.loads(rule.excel_fields) if rule.excel_fields else [],
        }

        # 写入 data/rules/{场景名}.json
        rules_data_dir = BASE_DIR / "data" / "rules"
        rules_data_dir.mkdir(parents=True, exist_ok=True)
        rule_file_path = rules_data_dir / f"{scene.name}.json"
        rule_file_path.write_text(
            json.dumps(rule_data, ensure_ascii=False, indent=2),
            encoding='utf-8'
        )
        return {"success": True, "file": str(rule_file_path), "data": rule_data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 模型 & 策略列表
# ---------------------------------------------------------------------------
@app.get("/api/models/list")
async def list_models():
    """返回 models/ 目录下的可用模型列表（读取 yaml 文件名）"""
    model_files = list(MODELS_DIR.glob("*.yaml"))
    model_names = [f.stem for f in sorted(model_files)]
    return {"models": model_names}


@app.get("/api/strategies/list")
async def list_strategies():
    """返回 STRATEGIES 字典中注册的所有策略名称"""
    return {"strategies": list(STRATEGIES.keys())}


# ---------------------------------------------------------------------------
# API — 模型可用性检测
# ---------------------------------------------------------------------------
from model_test import test_model_availability

@app.post("/api/model/test")
async def api_test_model(request: Request):
    body = await request.json()
    model_config = body.get("model_config")
    if not model_config:
        raise HTTPException(400, "缺少 model_config")
    result = await test_model_availability(model_config)
    return result


# ---------------------------------------------------------------------------
# 工作台专用后台标注任务执行函数
# ---------------------------------------------------------------------------
def execute_workbench_annotation_task(workbench_task_id: str, override_row_ids: list = None):
    """
    后台执行工作台批量标注任务。
    支持任务内并发（多行同时标注）+ 全局并发上限 20。
    override_row_ids: 追加标注模式下，只标注这些行ID（不影响原任务 row_data 配置）。
    """
    model_name_for_release = ""
    task_start = time.time()
    try:
        db = SessionLocal()
        try:
            # 读取任务基本信息
            task = db.query(AnnotationTask).filter(AnnotationTask.id == workbench_task_id).first()
            if not task or task.status == "cancelled":
                return

            model_name_for_release = task.model_name
            model_config_name = task.model_config
            strategy_name = task.strategy
            task_concurrency = clamp_task_concurrency(task.concurrency)
            selected_prompt_names = json.loads(task.prompt_names) if task.prompt_names else []
            scene_id = task.scene_id
            file_id = task.file_id

            # 读取场景规则配置
            rule_config = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
            if rule_config:
                annotate_field_list = json.loads(rule_config.annotate_fields) if rule_config.annotate_fields else []
                answer_field = rule_config.answer_field or "人工标注答案"
                result_label_field = rule_config.result_label_field or "大模型标注答案"
            else:
                # 降级读取 rule.json 文件配置
                fallback_rule = load_rule()
                annotate_field_list = fallback_rule.get("annotate_fields", [])
                answer_field = fallback_rule.get("answer_field", "人工标注答案")
                result_label_field = fallback_rule.get("result_label_field", "大模型标注答案")

            # 获取选中的 Prompt 对象（按 prompt_names 过滤）
            selected_prompts = db.query(Prompt).filter(
                Prompt.scene_id == scene_id,
                Prompt.name.in_(selected_prompt_names)
            ).all() if selected_prompt_names else []

            # 构建场景所有 Prompt 的 prompt_list（供策略函数使用）
            all_scene_prompts = db.query(Prompt).filter(Prompt.scene_id == scene_id).all()
            prompt_list = [{"name": p.name, "content": p.content} for p in all_scene_prompts]

            # 构建知识文件列表
            knowledge_files = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).all()
            knowledge_list = [{"name": k.name, "content": k.content} for k in knowledge_files]

            # 获取待标注行（追加模式优先用 override_row_ids，否则用 row_data，否则全量）
            if override_row_ids:
                target_rows = db.query(ExcelRow).filter(
                    ExcelRow.file_id == file_id,
                    ExcelRow.id.in_(override_row_ids)
                ).order_by(ExcelRow.id.asc()).all()
            else:
                row_id_list_json = task.row_data
                if row_id_list_json:
                    try:
                        parsed = json.loads(row_id_list_json)
                        if isinstance(parsed, list) and parsed:
                            # 格式2：指定 row_ids 列表
                            target_rows = db.query(ExcelRow).filter(
                                ExcelRow.file_id == file_id,
                                ExcelRow.id.in_(parsed)
                            ).order_by(ExcelRow.row_index.asc()).all()
                        elif isinstance(parsed, dict) and ("row_start" in parsed or "row_end" in parsed):
                            # 格式3：按 row_index 范围筛选
                            range_query = db.query(ExcelRow).filter(ExcelRow.file_id == file_id)
                            rs = parsed.get("row_start")
                            re_ = parsed.get("row_end")
                            if rs is not None:
                                range_query = range_query.filter(ExcelRow.row_index >= int(rs))
                            if re_ is not None:
                                range_query = range_query.filter(ExcelRow.row_index <= int(re_))
                            target_rows = range_query.order_by(ExcelRow.row_index.asc()).all()
                        else:
                            target_rows = db.query(ExcelRow).filter(
                                ExcelRow.file_id == file_id
                            ).order_by(ExcelRow.row_index.asc()).all()
                    except (json.JSONDecodeError, TypeError):
                        target_rows = db.query(ExcelRow).filter(
                            ExcelRow.file_id == file_id
                        ).order_by(ExcelRow.row_index.asc()).all()
                else:
                    target_rows = db.query(ExcelRow).filter(
                        ExcelRow.file_id == file_id
                    ).order_by(ExcelRow.row_index.asc()).all()

            total_row_count = len(target_rows)

            # 在 session 关闭前，将 ORM 对象转为纯 Python 数据结构，避免 session 脱离后延迟加载失败
            prompt_data_list = [
                {
                    'id': p.id,
                    'name': p.name,
                    'content': p.content,
                    'role_name': getattr(p, 'role_name', ''),
                }
                for p in selected_prompts
            ]
            row_data_list = [
                {
                    'id': r.id,
                    'data': json.loads(r.data) if isinstance(r.data, str) else (r.data or {}),
                    'file_id': r.file_id,
                    'human_answer': getattr(r, 'human_answer', None),
                }
                for r in target_rows
            ]

            # 更新任务状态为 running
            task.status = "running"
            task.started_at = datetime.utcnow()
            db.commit()
        finally:
            db.close()

        success_count = 0
        failed_count = 0
        is_multi_prompt = len(prompt_data_list) > 1
        counter_lock = Lock()  # 保护 success_count / failed_count

        def annotate_single_row(row_dict):
            """标注单行 - 在线程池中执行，接收纯 dict 而非 ORM 对象"""
            nonlocal success_count, failed_count
        
            # 获取全局信号量（如果 20 个并发已满，则等待）
            GLOBAL_ANNOTATION_SEMAPHORE.acquire()
            try:
                # 检查任务是否被取消
                _db_check = SessionLocal()
                try:
                    task_check = _db_check.query(AnnotationTask).filter(
                        AnnotationTask.id == workbench_task_id
                    ).first()
                    if not task_check or task_check.status == "cancelled":
                        return
                finally:
                    _db_check.close()
        
                row_id = row_dict['id']
                row_data_full = row_dict['data']
                human_answer = row_dict.get('human_answer') or ''
                row_start = time.time()
        
                # 标记当前正在标注的行（内存操作，自带线程锁）
                _update_current_row_ids(task_id=workbench_task_id, add_id=row_id)
        
                # 从完整行数据中提取标注字段
                row_data_for_annotate = {k: row_data_full.get(k) for k in annotate_field_list}

                _db_write = SessionLocal()
                try:
                    try:
                        if not prompt_data_list:
                            # 无 Prompt：直接用空字符串调用策略（降级处理）
                            result = rest_ir(
                                "", row_data_for_annotate, model_config_name,
                                strategy_name, prompt_list, task_concurrency, knowledge_list
                            )
                            label = result.get(result_label_field)
                            match_type = calc_match_type(
                                human_answer, label or ""
                            ) if label else "UNKNOWN"
                            row_elapsed_ms = int((time.time() - row_start) * 1000)
                            upsert_annotation_result(
                                _db_write,
                                task_id=workbench_task_id,
                                row_id=row_id,
                                prompt_name="__default__",
                                model_name=model_name_for_release,
                                result=json.dumps(result, ensure_ascii=False),
                                label=label,
                                match_type=match_type,
                                duration_ms=row_elapsed_ms,
                            )
                            with counter_lock:
                                success_count += 1

                        elif not is_multi_prompt:
                            # 单 Prompt 标注
                            single_prompt = prompt_data_list[0]
                            filled_prompt = render_prompt(
                                single_prompt['content'], row_data_for_annotate, scene_id, _db_write
                            )["rendered"]

                            result = rest_ir(
                                filled_prompt, row_data_for_annotate, model_config_name,
                                strategy_name, prompt_list, task_concurrency, knowledge_list
                            )
                            label = result.get(result_label_field)
                            match_type = calc_match_type(
                                human_answer, label or ""
                            ) if label else "UNKNOWN"
                            row_elapsed_ms = int((time.time() - row_start) * 1000)

                            upsert_annotation_result(
                                _db_write,
                                task_id=workbench_task_id,
                                row_id=row_id,
                                prompt_name=single_prompt['name'],
                                model_name=model_name_for_release,
                                result=json.dumps(result, ensure_ascii=False),
                                label=label,
                                match_type=match_type,
                                duration_ms=row_elapsed_ms,
                            )
                            with counter_lock:
                                success_count += 1

                        else:
                            # 多 Prompt 多角色标注：每个 Prompt 独立调用，最后合并
                            per_role_labels = []
                            for prompt_dict in prompt_data_list:
                                filled_prompt = render_prompt(
                                    prompt_dict['content'], row_data_for_annotate, scene_id, _db_write
                                )["rendered"]

                                result = rest_ir(
                                    filled_prompt, row_data_for_annotate, model_config_name,
                                    strategy_name, prompt_list, task_concurrency, knowledge_list
                                )
                                label = result.get(result_label_field)
                                role_match_type = calc_match_type(
                                    human_answer, label or ""
                                ) if label else "UNKNOWN"
                                per_role_labels.append(label)

                                # 存储每个角色的独立标注结果
                                upsert_annotation_result(
                                    _db_write,
                                    task_id=workbench_task_id,
                                    row_id=row_id,
                                    prompt_name=prompt_dict['name'],
                                    model_name=model_name_for_release,
                                    result=json.dumps(result, ensure_ascii=False),
                                    label=label,
                                    match_type=role_match_type,
                                )

                            # 合并判断规则：全"是"才"是"，任一"否"即"否"
                            normalized_labels = [
                                normalize_binary_label(lbl)
                                for lbl in per_role_labels
                                if lbl is not None
                            ]
                            if normalized_labels and all(l == "是" for l in normalized_labels):
                                merged_label = "是"
                            elif any(l == "否" for l in normalized_labels):
                                merged_label = "否"
                            else:
                                merged_label = "UNKNOWN"

                            merged_match_type = calc_match_type(
                                human_answer, merged_label
                            )

                            row_elapsed_ms = int((time.time() - row_start) * 1000)

                            # 存储合并结果（prompt_name 标记为 __merged__）
                            upsert_annotation_result(
                                _db_write,
                                task_id=workbench_task_id,
                                row_id=row_id,
                                prompt_name="__merged__",
                                model_name=model_name_for_release,
                                label=merged_label,
                                merged_label=merged_label,
                                match_type=merged_match_type,
                                duration_ms=row_elapsed_ms,
                            )
                            with counter_lock:
                                success_count += 1

                    except Exception as row_exc:
                        # 单行标注失败，记录错误但继续其他行
                        row_elapsed_ms = int((time.time() - row_start) * 1000)
                        upsert_annotation_result(
                            _db_write,
                            task_id=workbench_task_id,
                            row_id=row_id,
                            prompt_name="__error__",
                            model_name=model_name_for_release,
                            error=str(row_exc),
                            match_type="UNKNOWN",
                            duration_ms=row_elapsed_ms,
                        )
                        with counter_lock:
                            failed_count += 1

                    _db_write.commit()
                finally:
                    _db_write.close()

                # 该行标注完成，从当前标注行ID列表中移除（内存操作，自带线程锁）
                _update_current_row_ids(task_id=workbench_task_id, remove_id=row_id)

            finally:
                GLOBAL_ANNOTATION_SEMAPHORE.release()

        # 使用线程池并发执行标注
        effective_concurrency = min(task_concurrency, 20)
        with ThreadPoolExecutor(max_workers=effective_concurrency) as row_executor:
            futures = {row_executor.submit(annotate_single_row, row_dict): row_dict for row_dict in row_data_list}
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as fut_exc:
                    with counter_lock:
                        failed_count += 1

        # 计算任务最终统计指标
        db = SessionLocal()
        try:
            task_to_update = db.query(AnnotationTask).filter(
                AnnotationTask.id == workbench_task_id
            ).first()

            if override_row_ids:
                # 追加模式：增量更新计数，防止并发覆盖
                db.execute(
                    text("UPDATE annotation_tasks SET success_count = COALESCE(success_count, 0) + :sc, failed_count = COALESCE(failed_count, 0) + :fc WHERE id = :tid"),
                    {"sc": success_count, "fc": failed_count, "tid": workbench_task_id}
                )
                db.commit()
                # 重新读取最新计数
                task_to_update = db.query(AnnotationTask).filter(
                    AnnotationTask.id == workbench_task_id
                ).first()
            else:
                if task_to_update:
                    task_to_update.success_count = success_count
                    task_to_update.failed_count = failed_count

            # 从全量 AnnotationResult 重新计算混淆矩阵（追加模式需全量重算）
            if is_multi_prompt:
                final_results = db.query(AnnotationResult).filter(
                    AnnotationResult.task_id == workbench_task_id,
                    AnnotationResult.prompt_name == "__merged__"
                ).all()
            elif prompt_data_list:
                final_results = db.query(AnnotationResult).filter(
                    AnnotationResult.task_id == workbench_task_id,
                    AnnotationResult.prompt_name == prompt_data_list[0]['name']
                ).all()
            else:
                final_results = db.query(AnnotationResult).filter(
                    AnnotationResult.task_id == workbench_task_id,
                    AnnotationResult.prompt_name == "__default__"
                ).all()

            # 计算混淆矩阵各指标（排除 UNKNOWN）
            tp_count = sum(1 for r in final_results if r.match_type == "TP")
            fn_count = sum(1 for r in final_results if r.match_type == "FN")
            fp_count = sum(1 for r in final_results if r.match_type == "FP")
            tn_count = sum(1 for r in final_results if r.match_type == "TN")
            unknown_count = sum(1 for r in final_results if r.match_type == "UNKNOWN")
            valid_count = len(final_results) - unknown_count

            # 更新任务统计字段（统计指标已改为动态聚合，不再写入DB）
            if task_to_update:
                task_to_update.status = "success"
                task_to_update.finished_at = datetime.utcnow()
                task_to_update.duration_ms = int((time.time() - task_start) * 1000)
                task_to_update.current_row_id = None  # DB持久化清理（运行中不再频繁写DB）
                with TASK_CURRENT_ROWS_LOCK:
                    TASK_CURRENT_ROWS.pop(str(workbench_task_id), None)
            db.commit()
        finally:
            db.close()

    except Exception as task_exc:
        # 任务级异常：将任务标记为失败
        db = SessionLocal()
        try:
            failed_task = db.query(AnnotationTask).filter(
                AnnotationTask.id == workbench_task_id
            ).first()
            if failed_task and failed_task.status != "cancelled":
                failed_task.status = "failed"
                failed_task.error = str(task_exc)
                failed_task.finished_at = datetime.utcnow()
                failed_task.duration_ms = int((time.time() - task_start) * 1000)
                failed_task.current_row_id = None  # DB持久化清理
                with TASK_CURRENT_ROWS_LOCK:
                    TASK_CURRENT_ROWS.pop(str(workbench_task_id), None)
                db.commit()
        finally:
            db.close()
    finally:
        # 释放调度器占用的并发槽位
        release_scheduled_task(workbench_task_id, model_name_for_release)


# ---------------------------------------------------------------------------
# 辅助函数 — 内存维护 current_row_ids
# ---------------------------------------------------------------------------
def _update_current_row_ids(task_id: str, add_id=None, remove_id=None):
    """线程安全地更新任务当前正在标注的行ID列表（内存操作，不写DB）"""
    with TASK_CURRENT_ROWS_LOCK:
        current = TASK_CURRENT_ROWS.setdefault(task_id, set())
        if add_id is not None:
            current.add(add_id)
        if remove_id is not None:
            current.discard(remove_id)


# ---------------------------------------------------------------------------
# API — 标注工作台
# ---------------------------------------------------------------------------
@app.get("/api/workbench/rows")
async def workbench_get_rows(
    file_id: int = Query(...),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=200),
    task_id: Optional[str] = Query(None),
    match_type: Optional[str] = Query(None),
):
    """
    获取工作台数据行列表，支持分页和 match_type 过滤。
    如果指定 task_id，annotations 只返回该任务的结果；否则返回最近一次任务的结果。
    """
    db = SessionLocal()
    try:
        # 查询该文件的所有行（按行索引排序）
        base_query = db.query(ExcelRow).filter(ExcelRow.file_id == file_id)

        # 如果按 match_type 过滤，需先确定用哪个任务的结果
        effective_task_id = task_id
        if not effective_task_id:
            # 未指定 task_id，取该文件最新任务
            latest_task = db.query(AnnotationTask).filter(
                AnnotationTask.file_id == file_id
            ).order_by(AnnotationTask.created_at.desc()).first()
            if latest_task:
                effective_task_id = latest_task.id

        if match_type and effective_task_id:
            # 获取该任务中符合 match_type 的 row_id 集合
            matched_row_ids = [
                r[0] for r in db.query(AnnotationResult.row_id).filter(
                    AnnotationResult.task_id == effective_task_id,
                    AnnotationResult.match_type == match_type,
                ).distinct().all()
            ]
            base_query = base_query.filter(ExcelRow.id.in_(matched_row_ids))

        total_count = base_query.count()
        total_pages = max(1, math.ceil(total_count / size))
        current_page = min(page, total_pages)
        offset = (current_page - 1) * size
        page_rows = base_query.order_by(ExcelRow.row_index.asc()).offset(offset).limit(size).all()

        # ---- 行级标注状态计算 ----
        # 获取当前文件的活跃任务（pending 或 running）
        active_task = db.query(AnnotationTask).filter(
            AnnotationTask.file_id == file_id,
            AnnotationTask.status.in_(["pending", "running"])
        ).order_by(AnnotationTask.created_at.desc()).first()

        # 活跃任务下批量查标注结果（用于计算行状态）
        active_annotated_row_ids = set()
        active_error_row_ids = set()
        active_target_row_ids = None  # None 表示全量
        if active_task:
            if active_task.row_data:
                try:
                    parsed_row_data = json.loads(active_task.row_data)
                    if isinstance(parsed_row_data, list):
                        # 格式2：JSON list = 指定 row_ids
                        active_target_row_ids = set(parsed_row_data)
                    elif isinstance(parsed_row_data, dict) and ("row_start" in parsed_row_data or "row_end" in parsed_row_data):
                        # 格式3：JSON object {row_start, row_end} = 按 row_index 范围筛选
                        # 需要查询数据库获取对应范围内的实际行ID
                        range_q = db.query(ExcelRow.id).filter(ExcelRow.file_id == active_task.file_id)
                        rs = parsed_row_data.get("row_start")
                        re_ = parsed_row_data.get("row_end")
                        if rs is not None:
                            range_q = range_q.filter(ExcelRow.row_index >= int(rs))
                        if re_ is not None:
                            range_q = range_q.filter(ExcelRow.row_index <= int(re_))
                        active_target_row_ids = set(r.id for r in range_q.all())
                    else:
                        # 格式1：null 或无法识别 → 全量
                        active_target_row_ids = None
                except Exception:
                    active_target_row_ids = None
            # 批量查该任务所有标注结果
            active_results = db.query(AnnotationResult.row_id, AnnotationResult.prompt_name).filter(
                AnnotationResult.task_id == active_task.id
            ).all()
            for r in active_results:
                if r.prompt_name == '__error__':
                    active_error_row_ids.add(r.row_id)
                else:
                    active_annotated_row_ids.add(r.row_id)

        # 基于 effective_task_id 批量查标注结果（无论是否有活跃任务都需查询）
        # 修复：当用户指定 task_id 但存在活跃任务时，effective_annotated_row_ids 为空
        # 导致 get_row_status 中 task_id 分支总返回"未标注"
        effective_annotated_row_ids = set()
        effective_error_row_ids = set()
        if effective_task_id:
            # 如果 effective_task_id 与 active_task.id 相同，复用 active 任务结果避免重复查询
            if active_task and str(active_task.id) == str(effective_task_id):
                effective_annotated_row_ids = active_annotated_row_ids.copy()
                effective_error_row_ids = active_error_row_ids.copy()
            else:
                eff_results = db.query(AnnotationResult.row_id, AnnotationResult.prompt_name).filter(
                    AnnotationResult.task_id == effective_task_id
                ).all()
                for r in eff_results:
                    if r.prompt_name == '__error__':
                        effective_error_row_ids.add(r.row_id)
                    else:
                        effective_annotated_row_ids.add(r.row_id)

        def get_row_status(row_id):
            # 用户明确指定了 task_id，且该任务不是当前活跃任务时，只显示该任务的标注结果
            # 如果指定的 task_id 就是活跃任务，则走活跃任务逻辑以显示"排队中""标注中"等状态
            if task_id and effective_task_id and (not active_task or str(active_task.id) != str(effective_task_id)):
                if row_id in effective_annotated_row_ids:
                    return "已标注"
                if row_id in effective_error_row_ids:
                    return "失败"
                return "未标注"

            if active_task:
                if active_task.status == "pending":
                    if active_target_row_ids is None or row_id in active_target_row_ids:
                        return "任务创建中"
                elif active_task.status == "running":
                    # 从内存读取当前正在标注的行ID
                    with TASK_CURRENT_ROWS_LOCK:
                        current_ids = TASK_CURRENT_ROWS.get(str(active_task.id), set())
                    if row_id in current_ids:
                        return "标注中"
                    if row_id in active_error_row_ids:
                        return "失败"
                    elif row_id in active_annotated_row_ids:
                        return "已标注"
                    elif active_target_row_ids is None or row_id in active_target_row_ids:
                        return "排队中"
            # 无活跃任务时，检查 effective_task_id 的标注结果
            if effective_task_id:
                if row_id in effective_annotated_row_ids:
                    return "已标注"
                if row_id in effective_error_row_ids:
                    return "失败"
            return "未标注"

        # ---- 批量查当前页的标注结果（避免 N+1） ----
        page_row_ids = [r.id for r in page_rows]
        ann_map = {}  # row_id -> list of annotation dicts
        if effective_task_id and page_row_ids:
            raw_anns = db.query(AnnotationResult).filter(
                AnnotationResult.task_id == effective_task_id,
                AnnotationResult.row_id.in_(page_row_ids),
            ).all()
            for ann in raw_anns:
                ann_map.setdefault(ann.row_id, []).append({
                    "model_name": ann.model_name,
                    "prompt_name": ann.prompt_name,
                    "label": ann.label,
                    "merged_label": ann.merged_label,
                    "match_type": ann.match_type,
                    "result": json.loads(ann.result) if ann.result else {},
                })

        result_items = []
        for excel_row in page_rows:
            row_data_dict = json.loads(excel_row.data) if excel_row.data else {}
            annotation_list = ann_map.get(excel_row.id, [])

            result_items.append({
                "id": excel_row.id,
                "row_index": excel_row.row_index,
                "data": row_data_dict,
                "human_answer": excel_row.human_answer,
                "annotations": annotation_list,
                "row_status": get_row_status(excel_row.id),
            })

        return {
            "items": result_items,
            "total": total_count,
            "page": current_page,
            "size": size,
            "pages": total_pages,
            "task_id": effective_task_id,
        }
    finally:
        db.close()


@app.put("/api/workbench/rows/{row_id}")
async def update_workbench_row(row_id: int, request: Request):
    """编辑工作台行数据"""
    body = await request.json()
    db = SessionLocal()
    try:
        row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="行不存在")
        new_data = body.get("data")
        if new_data is not None:
            row.data = json.dumps(new_data, ensure_ascii=False) if isinstance(new_data, dict) else new_data
        db.commit()
        return {"success": True}
    finally:
        db.close()


@app.delete("/api/workbench/rows/{row_id}")
async def delete_workbench_row(row_id: int):
    """删除工作台行数据（同时删除关联标注结果）"""
    db = SessionLocal()
    try:
        row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="行不存在")
        # 删除该行的标注结果
        db.query(AnnotationResult).filter(AnnotationResult.row_id == row_id).delete(synchronize_session=False)
        db.delete(row)
        db.commit()
        return {"success": True}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/workbench/rows/{row_id}/annotations")
async def cancel_row_annotations(row_id: int):
    """取消标注：删除该行所有标注结果，使其回到未标注状态"""
    db = SessionLocal()
    try:
        row = db.query(ExcelRow).filter(ExcelRow.id == row_id).first()
        if not row:
            raise HTTPException(status_code=404, detail="行不存在")
        deleted = db.query(AnnotationResult).filter(AnnotationResult.row_id == row_id).delete(synchronize_session=False)
        db.commit()
        return {"success": True, "deleted_count": deleted}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/workbench/annotate")
async def workbench_start_annotation(request: Request):
    """
    创建工作台批量标注任务并提交到后台执行队列。
    支持全量标注、指定行标注，以及单/多 Prompt 多角色标注。
    追加模式：传入 task_id 时，从已有任务读取配置，直接对指定行执行追加标注。
    """
    body = await request.json()
    task_id = body.get("task_id")  # 可选：追加标注到已有任务
    file_id: int = body.get("file_id")
    row_ids = body.get("row_ids")  # 为空则全量
    row_start = body.get("row_start")  # 可选：按 row_index 筛选起始行（默认1）
    row_end = body.get("row_end")    # 可选：按 row_index 筛选结束行（null表示到最后）

    db = SessionLocal()
    try:
        # ===== 追加标注模式 =====
        if task_id:
            existing_task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
            if not existing_task:
                raise HTTPException(status_code=404, detail="任务不存在")
            if not row_ids:
                raise HTTPException(status_code=400, detail="追加标注必须指定 row_ids")

            # 计算实际可追加行数
            actual_append_rows = db.query(ExcelRow).filter(
                ExcelRow.file_id == existing_task.file_id,
                ExcelRow.id.in_(row_ids)
            ).count()
            if actual_append_rows == 0:
                raise HTTPException(status_code=400, detail="没有可标注的数据行")

            # 更新任务总行数（增量累加）
            existing_task.total_rows = (existing_task.total_rows or 0) + actual_append_rows

            # 更新 row_data：将追加行 ID 合并到任务目标行列表
            # 解决追加标注后刷新页面，行状态从"排队中"变为"未标注"的问题
            if existing_task.row_data:
                try:
                    existing_target_ids = json.loads(existing_task.row_data)
                    # dict 格式表示按范围筛选（如 {row_start, row_end}），无法合并 row_ids，视同全量
                    if isinstance(existing_target_ids, dict):
                        existing_target_ids = None
                    elif not isinstance(existing_target_ids, list):
                        existing_target_ids = [existing_target_ids]
                except (json.JSONDecodeError, TypeError):
                    existing_target_ids = []
            else:
                # row_data 为 None 表示全量标注，追加后仍为全量，无需更新
                existing_target_ids = None
            if existing_target_ids is not None:
                # 追加新的行 ID（去重）
                existing_id_set = set(existing_target_ids)
                for rid in row_ids:
                    if rid not in existing_id_set:
                        existing_target_ids.append(rid)
                existing_task.row_data = json.dumps(existing_target_ids, ensure_ascii=False)

            # 若任务已结束，重新置为运行中
            if existing_task.status in ('success', 'failed', 'cancelled'):
                existing_task.status = "running"
                existing_task.started_at = datetime.utcnow()
                existing_task.error = None
            db.commit()

            # 提交后台执行（追加模式：直接传 override_row_ids，不走调度器排队）
            TASK_EXECUTOR.submit(execute_workbench_annotation_task, task_id, row_ids)

            return {"task_id": task_id, "status": "running", "total_rows": actual_append_rows, "appended": True}

        # ===== 新建任务模式 =====
        model_config_name: str = body.get("model_config", "")
        strategy_name: str = body.get("strategy", "方案A")
        selected_prompt_names: list = body.get("prompt_names", [])
        concurrency: int = clamp_task_concurrency(body.get("concurrency", 1))

        if not file_id:
            raise HTTPException(status_code=400, detail="file_id 不能为空")
        if not model_config_name:
            raise HTTPException(status_code=400, detail="model_config 不能为空")

        # 校验文件存在
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail=f"文件 {file_id} 不存在")

        # 获取文件关联的场景ID（若无则取第一个场景）
        scene_id = excel_file.scene_id
        if not scene_id:
            first_scene = db.query(Scene).order_by(Scene.id.asc()).first()
            scene_id = first_scene.id if first_scene else None
        if not scene_id:
            raise HTTPException(status_code=400, detail="未找到可用场景，请先配置场景")

        # 计算实际行数（全量或指定行）
        if row_ids:
            actual_total_rows = db.query(ExcelRow).filter(
                ExcelRow.file_id == file_id,
                ExcelRow.id.in_(row_ids)
            ).count()
        elif row_start is not None or row_end is not None:
            # 按 row_index 范围筛选
            range_query = db.query(ExcelRow).filter(ExcelRow.file_id == file_id)
            if row_start is not None:
                range_query = range_query.filter(ExcelRow.row_index >= int(row_start))
            if row_end is not None:
                range_query = range_query.filter(ExcelRow.row_index <= int(row_end))
            actual_total_rows = range_query.count()
        else:
            actual_total_rows = db.query(ExcelRow).filter(
                ExcelRow.file_id == file_id
            ).count()

        if actual_total_rows == 0:
            raise HTTPException(status_code=400, detail="没有可标注的数据行")

        # 组合 model_name（格式：模型名(策略名)）
        model_display_name = get_model_display_name(model_config_name, strategy_name)

        # 创建工作台标注任务记录
        new_task_id = str(uuid4())
        workbench_task = AnnotationTask(
            id=new_task_id,
            file_id=file_id,
            scene_id=scene_id,
            model_name=model_display_name,
            model_config=model_config_name,
            strategy=strategy_name,
            concurrency=concurrency,
            total_rows=actual_total_rows,
            prompt_names=json.dumps(selected_prompt_names, ensure_ascii=False),
            # 复用 row_data 字段存储标注范围配置
            # 格式1：null = 全量标注
            # 格式2：JSON list = 指定 row_ids
            # 格式3：JSON object {row_start, row_end} = 按 row_index 范围筛选
            row_data=(
                json.dumps(row_ids, ensure_ascii=False) if row_ids
                else (json.dumps({"row_start": row_start, "row_end": row_end}, ensure_ascii=False)
                      if (row_start is not None or row_end is not None) else None)
            ),
            status="pending",
        )
        db.add(workbench_task)
        db.commit()

        # 直接尝试立即调度（快速占槽）
        with TASK_SCHEDULER_LOCK:
            if len(TASK_RUNNING_IDS) < MAX_TASK_CONCURRENCY:
                combo_limit = min(clamp_task_concurrency(concurrency), MAX_ACTIVE_TASKS_PER_COMBO)
                if TASK_ACTIVE_BY_COMBO[model_display_name] < combo_limit:
                    workbench_task.status = "running"
                    workbench_task.started_at = datetime.utcnow()
                    workbench_task.error = None
                    TASK_RUNNING_IDS.add(new_task_id)
                    TASK_ACTIVE_BY_COMBO[model_display_name] += 1
                    db.commit()
                    TASK_EXECUTOR.submit(execute_workbench_annotation_task, new_task_id)
        # 若未能立即调度，触发通用调度器重新检查
        schedule_pending_annotation_tasks()

        return {"task_id": new_task_id, "status": "pending", "total_rows": actual_total_rows}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()


@app.get("/api/workbench/stats")
async def workbench_get_stats(
    file_id: int = Query(...),
    task_id: Optional[str] = Query(None),
):
    """
    返回工作台标注统计指标（准确率、召回率、精确率、F1等）。
    准确率分母排除 UNKNOWN。
    """
    db = SessionLocal()
    try:
        # 确定统计所用的任务
        effective_task_id = task_id
        if not effective_task_id:
            latest_task = db.query(AnnotationTask).filter(
                AnnotationTask.file_id == file_id
            ).order_by(AnnotationTask.created_at.desc()).first()
            if latest_task:
                effective_task_id = latest_task.id

        total_row_count = db.query(ExcelRow).filter(ExcelRow.file_id == file_id).count()

        if not effective_task_id:
            return {
                "total": total_row_count, "annotated": 0,
                "tp": 0, "fn": 0, "fp": 0, "tn": 0, "unknown": 0,
                "accuracy": 0, "recall": 0, "precision": 0, "f1_score": 0,
            }

        # 优先取 __merged__ 结果；无则取单Prompt或__default__结果（去重）
        merged_results = db.query(AnnotationResult).filter(
            AnnotationResult.task_id == effective_task_id,
            AnnotationResult.prompt_name == "__merged__"
        ).all()

        if not merged_results:
            # 每行只取一条有效结果（排除错误行和合并行）
            all_results = db.query(AnnotationResult).filter(
                AnnotationResult.task_id == effective_task_id,
                AnnotationResult.prompt_name.notin_(["__error__", "__merged__"])
            ).all()
            seen_row_ids: set = set()
            deduped_results = []
            for r in all_results:
                if r.row_id not in seen_row_ids:
                    seen_row_ids.add(r.row_id)
                    deduped_results.append(r)
            final_results = deduped_results
        else:
            final_results = merged_results

        annotated_count = len(final_results)
        tp_count = sum(1 for r in final_results if r.match_type == "TP")
        fn_count = sum(1 for r in final_results if r.match_type == "FN")
        fp_count = sum(1 for r in final_results if r.match_type == "FP")
        tn_count = sum(1 for r in final_results if r.match_type == "TN")
        unknown_count = sum(1 for r in final_results if r.match_type == "UNKNOWN")
        valid_count = annotated_count - unknown_count  # 排除UNKNOWN的有效样本数

        return {
            "total": total_row_count,
            "annotated": annotated_count,
            "tp": tp_count,
            "fn": fn_count,
            "fp": fp_count,
            "tn": tn_count,
            "unknown": unknown_count,
            # 准确率：排除UNKNOWN后计算
            "accuracy": ratio(tp_count + tn_count, valid_count),
            "recall": ratio(tp_count, tp_count + fn_count),
            "precision": ratio(tp_count, tp_count + fp_count),
            "f1_score": ratio(2 * tp_count, 2 * tp_count + fp_count + fn_count),
            "task_id": effective_task_id,
        }
    finally:
        db.close()


@app.get("/api/workbench/tasks")
async def workbench_list_tasks(
    file_id: int = Query(...),
):
    """返回指定文件的所有标注任务列表（按创建时间倒序）"""
    db = SessionLocal()
    try:
        tasks = db.query(AnnotationTask).filter(
            AnnotationTask.file_id == file_id
        ).order_by(AnnotationTask.created_at.desc()).all()

        from sqlalchemy import func as sa_func

        # 批量预查询所有任务的统计指标（避免 N+1）
        task_ids_all = [t.id for t in tasks]
        _stats_cache: dict = {}
        if task_ids_all:
            _all_ann_results = db.query(AnnotationResult).filter(
                AnnotationResult.task_id.in_(task_ids_all),
                AnnotationResult.match_type.isnot(None),
            ).all()
            # 按 task_id 分组，先尝试 __merged__，否则排除 __error__
            from collections import defaultdict
            _by_task_merged: dict = defaultdict(list)
            _by_task_other: dict = defaultdict(list)
            for _r in _all_ann_results:
                if _r.prompt_name == "__merged__":
                    _by_task_merged[_r.task_id].append(_r)
                elif _r.prompt_name != "__error__":
                    _by_task_other[_r.task_id].append(_r)
            for _tid in task_ids_all:
                _rs = _by_task_merged[_tid] if _by_task_merged[_tid] else _by_task_other[_tid]
                _tp = sum(1 for _r in _rs if _r.match_type == "TP")
                _fn = sum(1 for _r in _rs if _r.match_type == "FN")
                _fp = sum(1 for _r in _rs if _r.match_type == "FP")
                _tn = sum(1 for _r in _rs if _r.match_type == "TN")
                _unk = sum(1 for _r in _rs if _r.match_type not in ("TP", "FN", "FP", "TN"))
                _valid = len(_rs) - _unk
                _stats_cache[_tid] = {
                    "accuracy": ratio(_tp + _tn, _valid),
                    "recall": ratio(_tp, _tp + _fn),
                    "precision": ratio(_tp, _tp + _fp),
                    "f1_score": ratio(2 * _tp, 2 * _tp + _fp + _fn),
                }

        task_list = []
        for t in tasks:
            sc = t.success_count or 0
            fc = t.failed_count or 0
            # 运行中的任务 或 已完成但DB统计为0的任务，实时从 AnnotationResult 统计
            need_realtime = t.status in ('running', 'pending') or (sc == 0 and fc == 0)
            if need_realtime:
                ann_counts = db.query(
                    sa_func.count(sa_func.distinct(AnnotationResult.row_id))
                ).filter(
                    AnnotationResult.task_id == t.id,
                    AnnotationResult.prompt_name != '__error__',
                ).scalar() or 0
                err_counts = db.query(
                    sa_func.count(sa_func.distinct(AnnotationResult.row_id))
                ).filter(
                    AnnotationResult.task_id == t.id,
                    AnnotationResult.prompt_name == '__error__',
                ).scalar() or 0
                # 仅当实时统计有值时才覆盖DB值（避免无标注结果时覆盖）
                if ann_counts > 0 or err_counts > 0:
                    sc = ann_counts
                    fc = err_counts
            # 动态计算耗时：已完成用 finished_at - created_at，运行中用 now - created_at
            computed_duration_ms = None
            if t.finished_at and t.created_at:
                computed_duration_ms = int((t.finished_at - t.created_at).total_seconds() * 1000)
            elif t.status in ('running',) and t.created_at:
                computed_duration_ms = int((datetime.utcnow() - t.created_at).total_seconds() * 1000)

            task_list.append({
                "id": t.id,
                "model_name": t.model_name,
                "strategy": t.strategy,
                "prompt_names": json.loads(t.prompt_names) if t.prompt_names else [],
                "concurrency": t.concurrency,
                "total_rows": t.total_rows,
                "success_count": sc,
                "failed_count": fc,
                "accuracy": _stats_cache.get(t.id, {}).get("accuracy"),
                "recall": _stats_cache.get(t.id, {}).get("recall"),
                "precision": _stats_cache.get(t.id, {}).get("precision"),
                "f1_score": _stats_cache.get(t.id, {}).get("f1_score"),
                "status": t.status,
                "error": t.error,
                "duration_ms": computed_duration_ms,
                "current_row_id": json.dumps(list(TASK_CURRENT_ROWS.get(str(t.id), set()))) if TASK_CURRENT_ROWS.get(str(t.id)) else None,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "started_at": t.started_at.isoformat() if t.started_at else None,
                "finished_at": t.finished_at.isoformat() if t.finished_at else None,
            })
            # 运行中的任务实时统计进度
            item = task_list[-1]
            if t.status in ('running', 'pending'):
                completed_count = sc
                with TASK_CURRENT_ROWS_LOCK:
                    annotating_count = len(TASK_CURRENT_ROWS.get(str(t.id), set()))
                failed_rows = fc
                queuing_count = max(0, (t.total_rows or 0) - completed_count - annotating_count - failed_rows)
                item["annotating_count"] = annotating_count
                item["completed_count"] = completed_count
                item["queuing_count"] = queuing_count
        return {"tasks": task_list}
    finally:
        db.close()


@app.get("/api/workbench/task-status")
async def workbench_task_status(
    task_ids: str = Query(...),
):
    """批量查询任务状态，task_ids 为逗号分隔的 UUID 字符串"""
    id_list = [tid.strip() for tid in task_ids.split(",") if tid.strip()]
    if not id_list:
        return {"tasks": []}

    db = SessionLocal()
    try:
        tasks = db.query(AnnotationTask).filter(
            AnnotationTask.id.in_(id_list)
        ).all()

        result_tasks = []
        for t in tasks:
            sc = t.success_count or 0
            fc = t.failed_count or 0
            # 运行中的任务 或 已完成但DB统计为0的任务，实时从 AnnotationResult 统计
            need_realtime = t.status in ('running', 'pending') or (sc == 0 and fc == 0)
            if need_realtime:
                from sqlalchemy import func as sa_func
                ann_counts = db.query(
                    sa_func.count(sa_func.distinct(AnnotationResult.row_id))
                ).filter(
                    AnnotationResult.task_id == t.id,
                    AnnotationResult.prompt_name != '__error__',
                ).scalar() or 0
                err_counts = db.query(
                    sa_func.count(sa_func.distinct(AnnotationResult.row_id))
                ).filter(
                    AnnotationResult.task_id == t.id,
                    AnnotationResult.prompt_name == '__error__',
                ).scalar() or 0
                if ann_counts > 0 or err_counts > 0:
                    sc = ann_counts
                    fc = err_counts
            result_tasks.append({
                "id": t.id,
                "status": t.status,
                "success_count": sc,
                "failed_count": fc,
                "total_rows": t.total_rows,
                "accuracy": calc_task_stats(str(t.id), db).get("accuracy"),
                "error": t.error,
                "finished_at": t.finished_at.isoformat() if t.finished_at else None,
                "current_row_id": json.dumps(list(TASK_CURRENT_ROWS.get(str(t.id), set()))) if TASK_CURRENT_ROWS.get(str(t.id)) else None,
            })

        return {"tasks": result_tasks}
    finally:
        db.close()


@app.post("/api/workbench/tasks/{task_id}/cancel")
async def workbench_cancel_task(task_id: str):
    """取消指定工作台标注任务"""
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        if task.status in TASK_ACTIVE_STATUSES:
            task.status = "cancelled"
            task.finished_at = datetime.utcnow()
            db.commit()
            forget_annotation_tasks([task_id])
            schedule_pending_annotation_tasks()
        return {"success": True, "task_id": task_id, "status": task.status}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()


@app.delete("/api/workbench/tasks/{task_id}")
async def workbench_delete_task(task_id: str):
    """删除工作台标注任务及其所有标注结果"""
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        # 如果正在运行，先标记取消
        if task.status in TASK_ACTIVE_STATUSES:
            task.status = "cancelled"
            task.finished_at = datetime.utcnow()
            forget_annotation_tasks([task_id])
            schedule_pending_annotation_tasks()
            db.commit()
        # 删除该任务的所有标注结果
        db.query(AnnotationResult).filter(AnnotationResult.task_id == task_id).delete()
        # 删除任务本身
        db.delete(task)
        db.commit()
        return {"success": True, "task_id": task_id}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()



# ---------------------------------------------------------------------------
# API — Excel 数据管理
# ---------------------------------------------------------------------------
@app.post("/api/excel/upload")
async def upload_excel_file(
    file: UploadFile = File(...),
    scene_id: str = Form(default=""),
):
    """上传Excel文件，解析后存入数据库"""
    content_bytes = await file.read()
    if not content_bytes:
        raise HTTPException(status_code=400, detail="上传文件为空")

    # 解析Excel
    try:
        df = read_uploaded_content(file.filename, content_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"文件解析失败: {e}")

    columns = df.columns.tolist()
    total_rows = len(df)

    # 获取场景信息
    db = SessionLocal()
    try:
        scene_name = "default"
        scene_id_int = None
        if scene_id and scene_id.strip():
            scene_id_int = int(scene_id.strip())
            scene_obj = db.query(Scene).filter(Scene.id == scene_id_int).first()
            if scene_obj:
                scene_name = scene_obj.name

        # 存储文件到 data/datasets/{场景名}/
        dataset_dir = DATA_DIR / "datasets" / scene_name
        dataset_dir.mkdir(parents=True, exist_ok=True)
        file_uuid = str(uuid4())[:8]
        stored_filename = f"{file_uuid}_{file.filename}"
        file_save_path = dataset_dir / stored_filename
        with open(file_save_path, "wb") as f:
            f.write(content_bytes)

        # 获取场景的 answer_field
        answer_field = "人工标注答案"
        if scene_id_int:
            rule_config = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id_int).first()
            if rule_config and rule_config.answer_field:
                answer_field = rule_config.answer_field

        # 创建 ExcelFile 记录
        excel_file = ExcelFile(
            file_name=file.filename,
            original_file_name=file.filename,
            scene_id=scene_id_int,
            total_rows=total_rows,
            annotated_count=0,
            columns_info=json.dumps(columns, ensure_ascii=False),
            display_columns=json.dumps(columns, ensure_ascii=False),
            file_path=str(file_save_path),
        )
        db.add(excel_file)
        db.flush()  # 获取 excel_file.id

        # 若该场景没有规则配置，自动创建默认规则
        if scene_id_int:
            existing_rule = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id_int).first()
            if not existing_rule:
                new_rule = RuleConfig(
                    scene_id=scene_id_int,
                    excel_fields=json.dumps(columns, ensure_ascii=False),
                    annotate_fields="[]",
                    answer_field="",
                    result_label_field="",
                )
                db.add(new_rule)
                rules_data_dir = DATA_DIR / "rules"
                rules_data_dir.mkdir(parents=True, exist_ok=True)
                rule_data = {
                    "excel_fields": columns,
                    "annotate_fields": [],
                    "answer_field": "",
                    "result_label_field": "",
                }
                (rules_data_dir / f"{scene_name}.json").write_text(
                    json.dumps(rule_data, ensure_ascii=False, indent=2), encoding="utf-8"
                )

        # 逐行解析插入 ExcelRow
        annotated_count = 0
        for idx, row in df.iterrows():
            row_dict = {}
            for col in columns:
                val = row[col]
                row_dict[col] = None if pd.isna(val) else val

            human_answer = row_dict.get(answer_field)
            if human_answer is not None:
                human_answer = str(human_answer).strip()
                if human_answer:
                    annotated_count += 1

            db.add(ExcelRow(
                file_id=excel_file.id,
                row_index=int(idx),
                data=json.dumps(row_dict, ensure_ascii=False, default=str),
                human_answer=human_answer if human_answer else None,
            ))

        # 提取COT名称列（大小写不敏感）
        cot_column = None
        for col in columns:
            if col.strip().lower() == 'cot名称':
                cot_column = col
                break
        cot_names_list = []
        has_cot = False
        if cot_column:
            has_cot = True
            cot_names_list = df[cot_column].dropna().astype(str).str.strip().unique().tolist()
            cot_names_list = [name for name in cot_names_list if name]  # 去空
            excel_file.cot_names = json.dumps(cot_names_list, ensure_ascii=False)

        # 更新已标注数量
        excel_file.annotated_count = annotated_count
        db.commit()
        db.refresh(excel_file)

        return {
            "id": excel_file.id,
            "file_name": excel_file.file_name,
            "total_rows": excel_file.total_rows,
            "annotated_count": excel_file.annotated_count,
            "columns_info": columns,
            "scene_name": scene_name,
            "has_cot": has_cot,
            "cot_names": cot_names_list,
            "created_at": excel_file.created_at.isoformat() if excel_file.created_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"上传处理失败: {e}")
    finally:
        db.close()


@app.get("/api/excel/list")
async def list_excel_files(
    scene_id: Optional[int] = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    search: Optional[str] = Query(default=None),
    sort_by: Optional[str] = Query(default=None),
    order: str = Query(default="asc"),
):
    """获取Excel文件列表（分页、搜索、排序）"""
    db = SessionLocal()
    try:
        query = db.query(ExcelFile)

        # 场景过滤
        if scene_id is not None:
            query = query.filter(ExcelFile.scene_id == scene_id)

        # 搜索
        if search and search.strip():
            keyword = f"%{search.strip()}%"
            query = query.filter(ExcelFile.file_name.like(keyword))

        # 排序
        total = query.count()
        sort_column = None
        if sort_by == "file_name":
            sort_column = ExcelFile.file_name
        elif sort_by == "total_rows":
            sort_column = ExcelFile.total_rows
        elif sort_by == "created_at":
            sort_column = ExcelFile.created_at
        elif sort_by == "annotated_count":
            sort_column = ExcelFile.annotated_count

        if sort_column is not None:
            query = query.order_by(sort_column.desc() if order == "desc" else sort_column.asc())
        else:
            query = query.order_by(ExcelFile.id.desc())

        # 分页
        offset = (page - 1) * size
        items = query.offset(offset).limit(size).all()

        # 组装返回数据
        result_items = []
        for f in items:
            # 查询场景名
            scene_name = ""
            if f.scene_id:
                scene_obj = db.query(Scene).filter(Scene.id == f.scene_id).first()
                if scene_obj:
                    scene_name = scene_obj.name

            # 动态统计已标注数量
            annotated = db.query(ExcelRow).filter(
                ExcelRow.file_id == f.id,
                ExcelRow.human_answer.isnot(None),
                ExcelRow.human_answer != "",
            ).count()

            columns_info = json.loads(f.columns_info) if f.columns_info else []

            result_items.append({
                "id": f.id,
                "file_name": f.file_name,
                "total_rows": f.total_rows,
                "annotated_count": annotated,
                "columns_info": columns_info,
                "scene_name": scene_name,
                "scene_id": f.scene_id,
                "created_at": f.created_at.isoformat() if f.created_at else None,
            })

        return {
            "items": result_items,
            "total": total,
            "page": page,
            "size": size,
        }
    finally:
        db.close()


@app.get("/api/excel/{file_id}")
async def get_excel_file(file_id: int):
    """获取单个Excel文件详情"""
    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")

        scene_name = ""
        if excel_file.scene_id:
            scene_obj = db.query(Scene).filter(Scene.id == excel_file.scene_id).first()
            if scene_obj:
                scene_name = scene_obj.name

        annotated = db.query(ExcelRow).filter(
            ExcelRow.file_id == file_id,
            ExcelRow.human_answer.isnot(None),
            ExcelRow.human_answer != "",
        ).count()

        columns_info = json.loads(excel_file.columns_info) if excel_file.columns_info else []
        display_columns = json.loads(excel_file.display_columns) if excel_file.display_columns else []

        return {
            "id": excel_file.id,
            "file_name": excel_file.file_name,
            "original_file_name": excel_file.original_file_name,
            "total_rows": excel_file.total_rows,
            "annotated_count": annotated,
            "columns_info": columns_info,
            "display_columns": display_columns,
            "scene_id": excel_file.scene_id,
            "scene_name": scene_name,
            "file_path": excel_file.file_path,
            "created_at": excel_file.created_at.isoformat() if excel_file.created_at else None,
            "updated_at": excel_file.updated_at.isoformat() if excel_file.updated_at else None,
        }
    finally:
        db.close()


@app.put("/api/excel/{file_id}")
async def update_excel_file(file_id: int, request: Request):
    """修改文件名"""
    body = await request.json()
    new_name = (body.get("file_name") or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")
        excel_file.file_name = new_name
        db.commit()
        db.refresh(excel_file)
        return {
            "id": excel_file.id,
            "file_name": excel_file.file_name,
            "success": True,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/excel/{file_id}")
async def delete_excel_file(file_id: int):
    """删除Excel文件及关联数据"""
    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")

        # 删除关联的 annotation_results（通过 annotation_tasks 关联）
        related_task_ids = [
            t.id for t in db.query(AnnotationTask).filter(AnnotationTask.file_id == file_id).all()
        ]
        if related_task_ids:
            db.query(AnnotationResult).filter(AnnotationResult.task_id.in_(related_task_ids)).delete(synchronize_session=False)
            db.query(AnnotationTask).filter(AnnotationTask.file_id == file_id).delete(synchronize_session=False)

        # 删除关联的 excel_rows
        db.query(ExcelRow).filter(ExcelRow.file_id == file_id).delete(synchronize_session=False)

        # 删除本地文件
        if excel_file.file_path:
            local_file = Path(excel_file.file_path)
            if local_file.exists():
                local_file.unlink()

        # 删除 ExcelFile 记录
        db.delete(excel_file)
        db.commit()
        return {"success": True, "message": f"文件 '{excel_file.file_name}' 已删除"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/excel/{file_id}/display-columns")
async def update_display_columns(file_id: int, request: Request):
    """设定显示列"""
    body = await request.json()
    display_columns = body.get("display_columns", [])
    if not isinstance(display_columns, list):
        raise HTTPException(status_code=400, detail="display_columns 必须是数组")

    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")
        excel_file.display_columns = json.dumps(display_columns, ensure_ascii=False)
        db.commit()
        return {"success": True, "display_columns": display_columns}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.get("/api/excel/{file_id}/annotate-config")
async def get_annotate_config(file_id: int):
    """获取Excel文件的默认标注配置"""
    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file or not excel_file.annotate_config:
            return {"config": None}
        return {"config": json.loads(excel_file.annotate_config)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/excel/{file_id}/annotate-config")
async def save_annotate_config(file_id: int, request: Request):
    """保存Excel文件的默认标注配置"""
    body = await request.json()
    config = {
        "model_config": body.get("model_config"),
        "strategy": body.get("strategy"),
        "concurrency": body.get("concurrency", 1),
        "prompt_names": body.get("prompt_names", []),
    }
    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")
        excel_file.annotate_config = json.dumps(config, ensure_ascii=False)
        db.commit()
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/excel/{file_id}/refresh-local")
async def refresh_local_excel(file_id: int):
    """从数据库重新生成本地Excel文件（覆盖原文件）"""
    db = SessionLocal()
    try:
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")

        # 读取所有 excel_rows
        rows = db.query(ExcelRow).filter(ExcelRow.file_id == file_id).order_by(ExcelRow.row_index.asc()).all()
        if not rows:
            raise HTTPException(status_code=400, detail="该文件没有数据行")

        # 构建 DataFrame
        records = []
        for r in rows:
            data_dict = json.loads(r.data) if r.data else {}
            records.append(data_dict)
        df = pd.DataFrame(records)

        # 写入原 file_path
        if excel_file.file_path:
            file_save_path = Path(excel_file.file_path)
            file_save_path.parent.mkdir(parents=True, exist_ok=True)
            suffix = file_save_path.suffix.lower()
            if suffix == ".csv":
                df.to_csv(file_save_path, index=False, encoding="utf-8-sig")
            else:
                df.to_excel(file_save_path, index=False, engine="openpyxl")
        else:
            raise HTTPException(status_code=400, detail="文件路径为空，无法刷新")

        return {"success": True, "message": f"文件 '{excel_file.file_name}' 本地文件已刷新"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/excel/refresh-all")
async def refresh_all_local_excel():
    """全局刷新：遍历所有ExcelFile，逐个执行refresh-local逻辑"""
    db = SessionLocal()
    try:
        excel_files = db.query(ExcelFile).all()
        success_count = 0
        fail_count = 0
        fail_messages = []

        for ef in excel_files:
            try:
                # 读取所有 excel_rows
                rows = db.query(ExcelRow).filter(ExcelRow.file_id == ef.id).order_by(ExcelRow.row_index.asc()).all()
                if not rows:
                    fail_count += 1
                    fail_messages.append(f"{ef.file_name}: 无数据行")
                    continue

                # 构建 DataFrame
                records = []
                for r in rows:
                    data_dict = json.loads(r.data) if r.data else {}
                    records.append(data_dict)
                df = pd.DataFrame(records)

                # 写入原 file_path
                if ef.file_path:
                    file_save_path = Path(ef.file_path)
                    file_save_path.parent.mkdir(parents=True, exist_ok=True)
                    suffix = file_save_path.suffix.lower()
                    if suffix == ".csv":
                        df.to_csv(file_save_path, index=False, encoding="utf-8-sig")
                    else:
                        df.to_excel(file_save_path, index=False, engine="openpyxl")
                    success_count += 1
                else:
                    fail_count += 1
                    fail_messages.append(f"{ef.file_name}: 文件路径为空")
            except Exception as e:
                fail_count += 1
                fail_messages.append(f"{ef.file_name}: {str(e)}")

        return {
            "success": True,
            "total": len(excel_files),
            "success_count": success_count,
            "fail_count": fail_count,
            "fail_messages": fail_messages,
        }
    finally:
        db.close()


@app.post("/api/excel/extract-cot-names")
async def extract_cot_names():
    """手动触发为所有 cot_names 为空的文件补全 COT 名称，返回更新了多少个文件"""
    db = SessionLocal()
    try:
        files_need_cot = db.query(ExcelFile).filter(
            (ExcelFile.cot_names == None) | (ExcelFile.cot_names == '') | (ExcelFile.cot_names == '[]')
        ).all()
        updated_count = 0
        updated_files = []
        for excel_file in files_need_cot:
            if not excel_file.file_path or not os.path.exists(excel_file.file_path):
                continue
            try:
                df = pd.read_excel(excel_file.file_path)
                cot_column = None
                for col in df.columns:
                    if col.strip().lower() == 'cot名称':
                        cot_column = col
                        break
                if cot_column:
                    cot_names_list = df[cot_column].dropna().astype(str).str.strip().unique().tolist()
                    cot_names_list = [name for name in cot_names_list if name]
                    if cot_names_list:
                        excel_file.cot_names = json.dumps(cot_names_list, ensure_ascii=False)
                        updated_count += 1
                        updated_files.append(excel_file.file_name)
            except Exception:
                continue
        db.commit()
        return {
            "success": True,
            "updated_count": updated_count,
            "updated_files": updated_files,
            "total_scanned": len(files_need_cot),
        }
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"提取COT名称失败: {e}")
    finally:
        db.close()

# ---------------------------------------------------------------------------
# API — 策略列表
# ---------------------------------------------------------------------------
@app.get("/api/strategies")
async def get_strategies():
    """获取所有可用的标注策略列表"""
    return {"strategies": list(STRATEGIES.keys())}


# ---------------------------------------------------------------------------
# API — Prompt 管理（基于DB）
# ---------------------------------------------------------------------------
@app.get("/api/prompts")
async def list_prompts(scene_id: int = Query(..., description="场景ID")):
    """返回指定场景下所有Prompt列表"""
    db = SessionLocal()
    try:
        prompts = db.query(Prompt).filter(Prompt.scene_id == scene_id).order_by(Prompt.id.asc()).all()
        return [
            {
                "id": p.id,
                "name": p.name,
                "content": p.content,
                "file_type": p.file_type or ".prompt",
                "role_name": p.role_name or "",
                "created_at": p.created_at.isoformat() if p.created_at else None,
                "updated_at": p.updated_at.isoformat() if p.updated_at else None,
            }
            for p in prompts
        ]
    finally:
        db.close()


@app.post("/api/prompts")
async def create_prompt(request: Request):
    """新增Prompt，校验同场景下名称唯一性"""
    body = await request.json()
    scene_id = body.get("scene_id")
    name = (body.get("name") or "").strip()
    content_text = body.get("content", "")
    file_type = body.get("file_type") or ".prompt"
    role_name = (body.get("role_name") or "").strip()

    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")
    if not name:
        raise HTTPException(status_code=400, detail="Prompt名称不能为空")
    # 校验文件类型
    if file_type not in (".prompt", ".txt"):
        raise HTTPException(status_code=400, detail="file_type 仅支持 .prompt 和 .txt")

    db = SessionLocal()
    try:
        # 校验场景存在
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")
        # 校验同场景下名称唯一
        existing = db.query(Prompt).filter(Prompt.scene_id == scene_id, Prompt.name == name).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"该场景下已存在同名Prompt '{name}'")

        prompt = Prompt(scene_id=scene_id, name=name, content=content_text, file_type=file_type, role_name=role_name or None)
        db.add(prompt)
        db.commit()
        db.refresh(prompt)

        # 同步写入本地文件 data/prompts/{scene_name}/{name}{file_type}
        scene_prompt_dir = DATA_DIR / "prompts" / scene.name
        scene_prompt_dir.mkdir(parents=True, exist_ok=True)
        (scene_prompt_dir / f"{prompt.name}{prompt.file_type or '.prompt'}").write_text(prompt.content, encoding="utf-8")

        return {
            "id": prompt.id,
            "name": prompt.name,
            "content": prompt.content,
            "file_type": prompt.file_type or ".prompt",
            "role_name": prompt.role_name or "",
            "created_at": prompt.created_at.isoformat() if prompt.created_at else None,
            "updated_at": prompt.updated_at.isoformat() if prompt.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/prompts/{prompt_id}")
async def update_prompt(prompt_id: int, request: Request):
    """修改Prompt内容/名称/文件类型"""
    body = await request.json()
    db = SessionLocal()
    try:
        prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
        if not prompt:
            raise HTTPException(status_code=404, detail="Prompt不存在")

        # 更新名称（若提供）
        new_name = body.get("name")
        if new_name is not None:
            new_name = new_name.strip()
            if not new_name:
                raise HTTPException(status_code=400, detail="Prompt名称不能为空")
            # 校验同场景下名称唯一
            conflict = db.query(Prompt).filter(
                Prompt.scene_id == prompt.scene_id,
                Prompt.name == new_name,
                Prompt.id != prompt_id,
            ).first()
            if conflict:
                raise HTTPException(status_code=400, detail=f"该场景下已存在同名Prompt '{new_name}'")
            prompt.name = new_name

        # 更新内容
        if "content" in body:
            prompt.content = body["content"]

        # 更新文件类型
        new_file_type = body.get("file_type")
        if new_file_type is not None:
            if new_file_type not in (".prompt", ".txt"):
                raise HTTPException(status_code=400, detail="file_type 仅支持 .prompt 和 .txt")
            prompt.file_type = new_file_type

        # 更新角色名字
        if "role_name" in body:
            prompt.role_name = (body["role_name"] or "").strip() or None

        db.commit()
        db.refresh(prompt)

        # 同步写入本地文件 data/prompts/{scene_name}/{name}{file_type}
        scene = db.query(Scene).filter(Scene.id == prompt.scene_id).first()
        if scene:
            scene_prompt_dir = DATA_DIR / "prompts" / scene.name
            scene_prompt_dir.mkdir(parents=True, exist_ok=True)
            (scene_prompt_dir / f"{prompt.name}{prompt.file_type or '.prompt'}").write_text(prompt.content, encoding="utf-8")

        return {
            "id": prompt.id,
            "name": prompt.name,
            "content": prompt.content,
            "file_type": prompt.file_type or ".prompt",
            "role_name": prompt.role_name or "",
            "created_at": prompt.created_at.isoformat() if prompt.created_at else None,
            "updated_at": prompt.updated_at.isoformat() if prompt.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: int):
    """删除Prompt"""
    db = SessionLocal()
    try:
        prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
        if not prompt:
            raise HTTPException(status_code=404, detail="Prompt不存在")
        db.delete(prompt)
        db.commit()
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/prompts/check")
async def check_prompt(request: Request):
    """检查Prompt中是否包含该场景规则配置中annotate_fields对应的占位符"""
    body = await request.json()
    prompt_content = body.get("content", "")
    scene_id = body.get("scene_id")

    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")

    db = SessionLocal()
    try:
        # 读取该场景的规则配置
        rule_config = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
        if not rule_config or not rule_config.annotate_fields:
            # 没有规则配置，无法检查，直接返回通过
            return {"valid": True, "missing_fields": [], "warnings": ["该场景未配置规则，无法进行占位符检查"]}

        annotate_fields = json.loads(rule_config.annotate_fields) if isinstance(rule_config.annotate_fields, str) else rule_config.annotate_fields

        # 提取Prompt中已使用的Python format占位符 {字段名}
        import re as _re
        used_fields = set(_re.findall(r'\{([^{}]+)\}', prompt_content))

        # 计算缺失的占位符
        missing_fields = [f for f in annotate_fields if f not in used_fields]

        # 计算多余占位符（在Prompt中使用但不在规则配置中）
        extra_fields = [f for f in used_fields if f not in annotate_fields]

        warnings = []
        if extra_fields:
            warnings.append(f"Prompt中使用了规则配置之外的占位符: {', '.join(extra_fields)}")
        if missing_fields:
            warnings.append(f"Prompt中缺少规则配置要求的占位符: {', '.join(missing_fields)}")

        return {
            "valid": len(missing_fields) == 0,
            "missing_fields": missing_fields,
            "warnings": warnings,
        }
    finally:
        db.close()


@app.post("/api/prompts/{prompt_id}/preview")
async def preview_prompt_render(prompt_id: int, request: Request):
    """预览 Prompt 渲染效果：用示例数据替换占位符，返回渲染结果"""
    body = await request.json()
    sample_source = body.get("sample_source", "first_row")  # "first_row" | "placeholder"
    file_id = body.get("file_id")

    db = SessionLocal()
    try:
        prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
        if not prompt:
            raise HTTPException(status_code=404, detail="Prompt不存在")

        scene_id = prompt.scene_id

        # 获取规则配置中的字段列表
        rule_config = db.query(RuleConfig).filter(RuleConfig.scene_id == scene_id).first()
        annotate_fields = []
        excel_fields = []
        if rule_config:
            if rule_config.annotate_fields:
                annotate_fields = json.loads(rule_config.annotate_fields)
            if rule_config.excel_fields:
                excel_fields = json.loads(rule_config.excel_fields)

        row_data: dict = {}
        if sample_source == "first_row":
            # 取该场景第一个文件的第一行
            target_file = None
            if file_id:
                target_file = db.query(ExcelFile).filter(
                    ExcelFile.id == file_id, ExcelFile.scene_id == scene_id
                ).first()
            if not target_file:
                target_file = (
                    db.query(ExcelFile)
                    .filter(ExcelFile.scene_id == scene_id)
                    .order_by(ExcelFile.id.asc())
                    .first()
                )
            if target_file:
                first_row = (
                    db.query(ExcelRow)
                    .filter(ExcelRow.file_id == target_file.id)
                    .order_by(ExcelRow.row_index.asc())
                    .first()
                )
                if first_row and first_row.data:
                    row_data = json.loads(first_row.data)

        if not row_data:
            # 无文件时用占位文本填充
            all_fields = list(dict.fromkeys(annotate_fields + excel_fields))
            row_data = {f: f"<示例值-{f}>" for f in all_fields}

        # 只传 annotate_fields 范围内的行数据（与标注时保持一致）
        if annotate_fields:
            row_data_for_render = {k: row_data.get(k, f"<示例值-{k}>") for k in annotate_fields}
        else:
            row_data_for_render = row_data

        result = render_prompt(prompt.content, row_data_for_render, scene_id, db)
        return result
    finally:
        db.close()


@app.post("/api/prompts/sync-local")
async def sync_prompts_to_local(request: Request):
    """将该场景所有Prompt同步到本地 data/prompts/{场景名}/ 目录，以DB数据为准覆盖写入"""
    body = await request.json()
    scene_id = body.get("scene_id")

    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")

    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")

        prompts = db.query(Prompt).filter(Prompt.scene_id == scene_id).all()

        # 确保目标目录存在
        scene_prompt_dir = DATA_DIR / "prompts" / scene.name
        scene_prompt_dir.mkdir(parents=True, exist_ok=True)

        # 先获取目录中已有文件，用于检测DB中已删除的文件
        existing_files = set(f.name for f in scene_prompt_dir.glob("*.*"))

        synced_count = 0
        synced_names = set()
        for p in prompts:
            file_name = f"{p.name}{p.file_type or '.prompt'}"
            file_path = scene_prompt_dir / file_name
            file_path.write_text(p.content, encoding="utf-8")
            synced_names.add(file_name)
            synced_count += 1

        # 删除DB中已不存在的本地文件
        deleted_files = []
        for f_name in existing_files - synced_names:
            (scene_prompt_dir / f_name).unlink()
            deleted_files.append(f_name)

        return {
            "success": True,
            "synced_count": synced_count,
            "deleted_files": deleted_files,
            "target_dir": str(scene_prompt_dir),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 知识文件管理（DB）
# ---------------------------------------------------------------------------
@app.get("/api/knowledge")
async def list_knowledge(scene_id: int = Query(...)):
    """获取指定场景下所有知识文件"""
    db = SessionLocal()
    try:
        files = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).order_by(KnowledgeFile.id.asc()).all()
        return [
            {
                "id": f.id,
                "name": f.name,
                "content": f.content,
                "file_type": f.file_type or ".txt",
                "created_at": f.created_at.isoformat() if f.created_at else None,
                "updated_at": f.updated_at.isoformat() if f.updated_at else None,
            }
            for f in files
        ]
    finally:
        db.close()


@app.post("/api/knowledge")
async def create_knowledge(request: Request):
    """新增知识文件，校验(scene_id, name)唯一性"""
    body = await request.json()
    scene_id = body.get("scene_id")
    name = (body.get("name") or "").strip()
    content = body.get("content", "")
    file_type = body.get("file_type", ".txt")
    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")
    if not name:
        raise HTTPException(status_code=400, detail="知识文件名称不能为空")
    if file_type not in (".json", ".jsonl", ".txt"):
        raise HTTPException(status_code=400, detail="不支持的文件类型，仅允许 .json/.jsonl/.txt")
    db = SessionLocal()
    try:
        # 校验(scene_id, name)唯一性
        existing = db.query(KnowledgeFile).filter(
            KnowledgeFile.scene_id == scene_id, KnowledgeFile.name == name
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail=f"该场景下已存在同名知识文件「{name}」")
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        kf = KnowledgeFile(scene_id=scene_id, name=name, content=content, file_type=file_type)
        db.add(kf)
        db.commit()
        db.refresh(kf)

        # 同步写入本地文件 data/knowledge/{scene_name}/{name}{file_type}
        if scene:
            scene_dir = DATA_DIR / "knowledge" / scene.name
            scene_dir.mkdir(parents=True, exist_ok=True)
            file_name = name if name.endswith((".json", ".jsonl", ".txt")) else f"{name}{file_type}"
            (scene_dir / file_name).write_text(kf.content or "", encoding="utf-8")

        return {
            "id": kf.id,
            "name": kf.name,
            "content": kf.content,
            "file_type": kf.file_type or ".txt",
            "created_at": kf.created_at.isoformat() if kf.created_at else None,
            "updated_at": kf.updated_at.isoformat() if kf.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/knowledge/{knowledge_id}")
async def update_knowledge(knowledge_id: int, request: Request):
    """更新知识文件"""
    body = await request.json()
    db = SessionLocal()
    try:
        kf = db.query(KnowledgeFile).filter(KnowledgeFile.id == knowledge_id).first()
        if not kf:
            raise HTTPException(status_code=404, detail="知识文件不存在")
        name = body.get("name")
        if name is not None:
            name = name.strip()
            if not name:
                raise HTTPException(status_code=400, detail="知识文件名称不能为空")
            # 校验重名
            conflict = db.query(KnowledgeFile).filter(
                KnowledgeFile.scene_id == kf.scene_id, KnowledgeFile.name == name, KnowledgeFile.id != knowledge_id
            ).first()
            if conflict:
                raise HTTPException(status_code=400, detail=f"该场景下已存在同名知识文件「{name}」")
            kf.name = name
        if "content" in body:
            kf.content = body["content"]
        if "file_type" in body:
            if body["file_type"] not in (".json", ".jsonl", ".txt"):
                raise HTTPException(status_code=400, detail="不支持的文件类型")
            kf.file_type = body["file_type"]
        db.commit()
        db.refresh(kf)

        # 同步写入本地文件 data/knowledge/{scene_name}/{name}{file_type}
        scene = db.query(Scene).filter(Scene.id == kf.scene_id).first()
        if scene:
            scene_dir = DATA_DIR / "knowledge" / scene.name
            scene_dir.mkdir(parents=True, exist_ok=True)
            file_name = kf.name if kf.name.endswith((".json", ".jsonl", ".txt")) else f"{kf.name}{kf.file_type or '.txt'}"
            (scene_dir / file_name).write_text(kf.content or "", encoding="utf-8")

        return {
            "id": kf.id,
            "name": kf.name,
            "content": kf.content,
            "file_type": kf.file_type or ".txt",
            "created_at": kf.created_at.isoformat() if kf.created_at else None,
            "updated_at": kf.updated_at.isoformat() if kf.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/knowledge/{knowledge_id}")
async def delete_knowledge(knowledge_id: int):
    """删除知识文件"""
    db = SessionLocal()
    try:
        kf = db.query(KnowledgeFile).filter(KnowledgeFile.id == knowledge_id).first()
        if not kf:
            raise HTTPException(status_code=404, detail="知识文件不存在")
        db.delete(kf)
        db.commit()
        return {"success": True, "message": "知识文件已删除"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.post("/api/knowledge/sync-local")
async def sync_knowledge_to_local(request: Request):
    """将指定场景的知识文件同步到 data/knowledge/{场景名}/ 目录"""
    body = await request.json()
    scene_id = body.get("scene_id")
    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(status_code=404, detail="场景不存在")
        files = db.query(KnowledgeFile).filter(KnowledgeFile.scene_id == scene_id).all()
        if not files:
            return {"success": True, "message": "无知识文件需要同步", "synced_count": 0}
        # 创建场景目录
        scene_dir = DATA_DIR / "knowledge" / scene.name
        scene_dir.mkdir(parents=True, exist_ok=True)
        synced_count = 0
        for kf in files:
            file_name = kf.name if kf.name.endswith((".json", ".jsonl", ".txt")) else f"{kf.name}{kf.file_type or '.txt'}"
            file_path = scene_dir / file_name
            # 安全校验：防止目录遍历
            if not str(file_path.resolve()).startswith(str(scene_dir.resolve())):
                continue
            file_path.write_text(kf.content or "", encoding="utf-8")
            synced_count += 1
        return {"success": True, "message": f"已同步 {synced_count} 个知识文件到 {scene_dir}", "synced_count": synced_count}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 错题集管理
# ---------------------------------------------------------------------------
@app.get("/api/error-books")
async def list_error_books(
    scene_id: int = Query(...),
    file_id: Optional[int] = Query(None),
    cot_name: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None),
):
    """分页查询错题列表"""
    db = SessionLocal()
    try:
        query = db.query(ErrorBook).filter(ErrorBook.scene_id == scene_id)
        if file_id:
            query = query.filter(ErrorBook.file_id == file_id)
        if cot_name:
            query = query.filter(ErrorBook.cot_name == cot_name)
        if search:
            search_pattern = f"%{search}%"
            # 同时搜索 original_data 和关联的 ExcelRow.data
            query = query.outerjoin(ExcelRow, ErrorBook.row_id == ExcelRow.id).filter(
                or_(
                    ErrorBook.original_data.like(search_pattern),
                    ErrorBook.expected_answer.like(search_pattern),
                    ErrorBook.actual_output.like(search_pattern),
                    ErrorBook.error_reason.like(search_pattern),
                    ExcelRow.data.like(search_pattern),
                )
            )
        total = query.count()
        items = query.order_by(ErrorBook.id.desc()).offset((page - 1) * size).limit(size).all()
        # 批量通过 row_id JOIN excel_rows 获取 original_data
        _er_ids = [e.row_id for e in items if e.row_id]
        _er_data_map = {}
        if _er_ids:
            for er in db.query(ExcelRow).filter(ExcelRow.id.in_(_er_ids)).all():
                _er_data_map[er.id] = er.data
        return {
            "items": [
                {
                    "id": e.id,
                    "scene_id": e.scene_id,
                    "file_id": e.file_id,
                    "cot_name": e.cot_name or "",
                    "original_data": _er_data_map.get(e.row_id, e.original_data or "") if e.row_id else (e.original_data or ""),
                    "expected_answer": e.expected_answer or "",
                    "actual_output": e.actual_output or "",
                    "error_reason": e.error_reason or "",
                    "created_at": e.created_at.isoformat() if e.created_at else None,
                    "updated_at": e.updated_at.isoformat() if e.updated_at else None,
                }
                for e in items
            ],
            "total": total,
            "page": page,
            "size": size,
        }
    finally:
        db.close()


@app.post("/api/error-books")
async def create_error_book(request: Request):
    """新增错题"""
    body = await request.json()
    scene_id = body.get("scene_id")
    file_id = body.get("file_id")
    cot_name = (body.get("cot_name") or "").strip()
    row_id = body.get("row_id") or None
    expected_answer = (body.get("expected_answer") or "").strip()
    actual_output = (body.get("actual_output") or "").strip()
    error_reason = (body.get("error_reason") or "").strip()
    if not scene_id:
        raise HTTPException(status_code=400, detail="scene_id 不能为空")

    # 有 row_id 时不写入 original_data（通过 JOIN 获取）；无 row_id 时保留独立存储
    original_data_value = None
    if not row_id:
        original_data_value = body.get("original_data", "")
        if isinstance(original_data_value, (dict, list)):
            original_data_value = json.dumps(original_data_value, ensure_ascii=False)
        original_data_value = original_data_value or None
    db = SessionLocal()
    try:
        eb = ErrorBook(
            scene_id=scene_id,
            file_id=file_id or None,
            cot_name=cot_name or None,
            row_id=row_id,
            original_data=original_data_value,
            expected_answer=expected_answer or None,
            actual_output=actual_output or None,
            error_reason=error_reason or None,
        )
        db.add(eb)
        db.commit()
        db.refresh(eb)
        # 返回时使用降级策略获取 original_data
        _resolved_od = eb.original_data or ""
        if eb.row_id:
            _row = db.query(ExcelRow).filter(ExcelRow.id == eb.row_id).first()
            _resolved_od = _row.data if _row else (eb.original_data or "")
        return {
            "id": eb.id,
            "scene_id": eb.scene_id,
            "file_id": eb.file_id,
            "cot_name": eb.cot_name or "",
            "original_data": _resolved_od,
            "expected_answer": eb.expected_answer or "",
            "actual_output": eb.actual_output or "",
            "error_reason": eb.error_reason or "",
            "created_at": eb.created_at.isoformat() if eb.created_at else None,
            "updated_at": eb.updated_at.isoformat() if eb.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.put("/api/error-books/{error_id}")
async def update_error_book(error_id: int, request: Request):
    """更新错题"""
    body = await request.json()
    db = SessionLocal()
    try:
        eb = db.query(ErrorBook).filter(ErrorBook.id == error_id).first()
        if not eb:
            raise HTTPException(status_code=404, detail="错题不存在")
        if "error_reason" in body:
            eb.error_reason = body["error_reason"] or None
        if "expected_answer" in body:
            eb.expected_answer = body["expected_answer"] or None
        if "actual_output" in body:
            eb.actual_output = body["actual_output"] or None
        if "original_data" in body:
            od = body["original_data"]
            if isinstance(od, (dict, list)):
                od = json.dumps(od, ensure_ascii=False)
            eb.original_data = od or None
        if "cot_name" in body:
            eb.cot_name = body["cot_name"] or None
        db.commit()
        db.refresh(eb)
        # 返回时使用降级策略获取 original_data
        _resolved_od = eb.original_data or ""
        if eb.row_id:
            _row = db.query(ExcelRow).filter(ExcelRow.id == eb.row_id).first()
            _resolved_od = _row.data if _row else (eb.original_data or "")
        return {
            "id": eb.id,
            "scene_id": eb.scene_id,
            "file_id": eb.file_id,
            "cot_name": eb.cot_name or "",
            "original_data": _resolved_od,
            "expected_answer": eb.expected_answer or "",
            "actual_output": eb.actual_output or "",
            "error_reason": eb.error_reason or "",
            "created_at": eb.created_at.isoformat() if eb.created_at else None,
            "updated_at": eb.updated_at.isoformat() if eb.updated_at else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.delete("/api/error-books/{error_id}")
async def delete_error_book(error_id: int):
    """删除错题"""
    db = SessionLocal()
    try:
        eb = db.query(ErrorBook).filter(ErrorBook.id == error_id).first()
        if not eb:
            raise HTTPException(status_code=404, detail="错题不存在")
        db.delete(eb)
        db.commit()
        return {"success": True, "message": "错题已删除"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        db.close()


@app.get("/api/error-books/cot-names")
async def get_error_book_cot_names(scene_id: int = Query(...), file_id: Optional[int] = Query(None)):
    """获取错题集COT名称列表 — 优先从 ExcelFile.cot_names 字段读取，降级到 ErrorBook 记录"""
    db = SessionLocal()
    try:
        # 优先从 ExcelFile.cot_names 读取
        if file_id:
            excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id, ExcelFile.scene_id == scene_id).first()
            if excel_file and excel_file.cot_names:
                try:
                    names = json.loads(excel_file.cot_names)
                    if isinstance(names, list) and names:
                        return sorted(set(n for n in names if n))
                except (json.JSONDecodeError, TypeError):
                    pass
        else:
            # 未指定 file_id，汇总该场景所有文件的 cot_names（去重合并）
            files = db.query(ExcelFile).filter(ExcelFile.scene_id == scene_id).all()
            all_names = set()
            for f in files:
                if f.cot_names:
                    try:
                        names = json.loads(f.cot_names)
                        if isinstance(names, list):
                            all_names.update(n for n in names if n)
                    except (json.JSONDecodeError, TypeError):
                        pass
            if all_names:
                return sorted(all_names)

        # 降级：从 ErrorBook 记录中查询（兼容旧数据）
        query = db.query(ErrorBook.cot_name).filter(ErrorBook.scene_id == scene_id, ErrorBook.cot_name.isnot(None), ErrorBook.cot_name != "")
        if file_id:
            query = query.filter(ErrorBook.file_id == file_id)
        cot_names = sorted(set(row[0] for row in query.distinct().all()))
        return cot_names
    finally:
        db.close()


@app.get("/api/error-books/datasets")
async def get_error_book_datasets(scene_id: int = Query(...)):
    """获取该场景下所有数据集(Excel文件)列表"""
    db = SessionLocal()
    try:
        files = db.query(ExcelFile).filter(ExcelFile.scene_id == scene_id).order_by(ExcelFile.id.asc()).all()
        return [{"id": f.id, "file_name": f.original_file_name or f.file_name} for f in files]
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 模型配置
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
# API — 导出 Excel（新版：按 file_id + task_id 生成4-Sheet 导出文件）
# ---------------------------------------------------------------------------
@app.post("/api/export")
async def export_annotation_excel(body: dict):
    """
    按文件ID和任务ID导出标注结果为4-Sheet Excel：
      Sheet1 标注数据 — 原始数据行 + 标注结果列
      Sheet2 统计数据 — 准确率/召回率/精确率/F1/混淆矩阵
      Sheet3 标注明细 — 每行标注详情
      Sheet4 导出信息 — 元信息
    """
    file_id = body.get("file_id")
    task_id = body.get("task_id")  # 可选，不传则取该文件最新任务
    if not file_id:
        raise HTTPException(status_code=400, detail="file_id is required")
    db = SessionLocal()
    try:
        # 查询文件信息
        excel_file = db.query(ExcelFile).filter(ExcelFile.id == file_id).first()
        if not excel_file:
            raise HTTPException(status_code=404, detail="文件不存在")
        # 确定有效的任务ID（不传则取该文件最新任务）
        effective_task_id = task_id
        if not effective_task_id:
            latest_task = (
                db.query(AnnotationTask)
                .filter(AnnotationTask.file_id == file_id)
                .order_by(AnnotationTask.created_at.desc())
                .first()
            )
            if latest_task:
                effective_task_id = latest_task.id
        # 查询任务详情
        annotation_task = None
        if effective_task_id:
            annotation_task = (
                db.query(AnnotationTask)
                .filter(AnnotationTask.id == effective_task_id)
                .first()
            )
        # 查询该文件所有数据行
        excel_rows = (
            db.query(ExcelRow)
            .filter(ExcelRow.file_id == file_id)
            .order_by(ExcelRow.row_index)
            .all()
        )
        # 查询标注结果：优先取 __merged__ 结果；无则取去重的普通结果
        all_annotation_results = []
        if effective_task_id:
            merged_results = (
                db.query(AnnotationResult)
                .filter(
                    AnnotationResult.task_id == effective_task_id,
                    AnnotationResult.prompt_name == "__merged__",
                )
                .all()
            )
            if merged_results:
                all_annotation_results = merged_results
            else:
                raw_results = (
                    db.query(AnnotationResult)
                    .filter(
                        AnnotationResult.task_id == effective_task_id,
                        AnnotationResult.prompt_name.notin_(["__error__", "__merged__"]),
                    )
                    .all()
                )
                seen_row_id_set: set = set()
                for annotation_result in raw_results:
                    if annotation_result.row_id not in seen_row_id_set:
                        seen_row_id_set.add(annotation_result.row_id)
                        all_annotation_results.append(annotation_result)
        # 构建 row_id -> 标注结果 映射
        annotation_result_map = {r.row_id: r for r in all_annotation_results}
        # ===== Sheet1：标注数据（原始数据 + 标注结果列）=====
        annotated_data_records = []
        for excel_row in excel_rows:
            raw_data_dict = json.loads(excel_row.data) if excel_row.data else {}
            annotation_result = annotation_result_map.get(excel_row.id)
            record = {
                "行号": excel_row.row_index,
                "人工答案": excel_row.human_answer or "",
            }
            record.update(raw_data_dict)
            record["标注结果"] = annotation_result.label if annotation_result else ""
            record["匹配类型"] = annotation_result.match_type if annotation_result else ""
            annotated_data_records.append(record)
        # ===== Sheet2：统计数据 =====
        total_row_count = len(excel_rows)
        annotated_count = len(all_annotation_results)
        tp_count = sum(1 for r in all_annotation_results if r.match_type == "TP")
        fn_count = sum(1 for r in all_annotation_results if r.match_type == "FN")
        fp_count = sum(1 for r in all_annotation_results if r.match_type == "FP")
        tn_count = sum(1 for r in all_annotation_results if r.match_type == "TN")
        unknown_count = sum(1 for r in all_annotation_results if r.match_type == "UNKNOWN")
        # 排除 UNKNOWN 后的有效样本数（用于计算准确率）
        valid_sample_count = annotated_count - unknown_count
        stats_record = {
            "总行数": total_row_count,
            "已标注数": annotated_count,
            "TP": tp_count, "FN": fn_count, "FP": fp_count, "TN": tn_count, "UNKNOWN": unknown_count,
            "准确率": format_percent_ratio(ratio(tp_count + tn_count, valid_sample_count)),
            "查全率(召回率)": format_percent_ratio(ratio(tp_count, tp_count + fn_count)),
            "查准率(精确率)": format_percent_ratio(ratio(tp_count, tp_count + fp_count)),
            "F1分数": format_percent_ratio(ratio(2 * tp_count, 2 * tp_count + fp_count + fn_count)),
            "模型": annotation_task.model_name if annotation_task else "",
            "策略": annotation_task.strategy if annotation_task else "",
        }
        # ===== Sheet3：标注明细 =====
        annotation_detail_records = []
        row_id_to_excel_row = {r.id: r for r in excel_rows}
        for annotation_result in all_annotation_results:
            excel_row = row_id_to_excel_row.get(annotation_result.row_id)
            result_data = json.loads(annotation_result.result) if annotation_result.result else {}
            detail_record = {
                "行号": excel_row.row_index if excel_row else "",
                "人工答案": excel_row.human_answer if excel_row else "",
                "标注结果": annotation_result.label or "",
                "匹配类型": annotation_result.match_type or "",
                "Prompt名称": annotation_result.prompt_name or "",
                "耗时(ms)": annotation_result.duration_ms or "",
                "耗时(格式)": format_duration_ms(annotation_result.duration_ms),
                "标注时间": annotation_result.created_at.isoformat() if annotation_result.created_at else "",
            }
            # 将标注结果额外字段展开
            for extra_key, extra_value in result_data.items():
                if extra_key not in detail_record:
                    detail_record[extra_key] = extra_value
            annotation_detail_records.append(detail_record)
        # ===== Sheet4：导出信息 =====
        export_info_record = {
            "导出时间": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
            "文件ID": file_id,
            "文件名": excel_file.original_file_name or excel_file.file_name,
            "任务ID": effective_task_id or "",
            "模型": annotation_task.model_name if annotation_task else "",
            "策略": annotation_task.strategy if annotation_task else "",
            "总行数": total_row_count,
            "已标注数": annotated_count,
            "准确率": format_percent_ratio(ratio(tp_count + tn_count, valid_sample_count)),
        }
        # ===== 生成 Excel 文件 =====
        excel_output_buffer = BytesIO()
        with pd.ExcelWriter(excel_output_buffer, engine="openpyxl") as excel_writer:
            pd.DataFrame(annotated_data_records).to_excel(excel_writer, sheet_name="标注数据", index=False)
            pd.DataFrame([stats_record]).to_excel(excel_writer, sheet_name="统计数据", index=False)
            pd.DataFrame(annotation_detail_records).to_excel(excel_writer, sheet_name="标注明细", index=False)
            pd.DataFrame([export_info_record]).to_excel(excel_writer, sheet_name="导出信息", index=False)
        excel_output_buffer.seek(0)
        # 构建含准确率信息的下载文件名
        model_name_part = sanitize_export_filename_part(
            annotation_task.model_name if annotation_task else "unknown", "unknown_model"
        )
        source_file_stem = sanitize_export_filename_part(
            Path(excel_file.original_file_name or excel_file.file_name or "").stem, "data"
        )
        accuracy_text = format_percent_ratio(ratio(tp_count + tn_count, valid_sample_count))
        download_filename = f"标注{annotated_count}条（准确率{accuracy_text}）+{model_name_part}+{source_file_stem}.xlsx"
        encoded_download_filename = quote(download_filename)
        return StreamingResponse(
            excel_output_buffer,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="annotation_export.xlsx"; '
                    f"filename*=UTF-8''{encoded_download_filename}"
                )
            },
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 导出 Excel（旧版：兼容保留，按 model 参数全量导出）
# ---------------------------------------------------------------------------
@app.get("/api/export")
async def export_zip(model: str = Query(...)):
    db = SessionLocal()
    try:
        model = (model or "").strip()
        if not model:
            raise HTTPException(status_code=400, detail="model is required")

        rows = db.query(ExcelRow).order_by(ExcelRow.id).all()
        # 批量通过 file_id JOIN excel_files 获取 file_name
        _ef_ids = list({r.file_id for r in rows if r.file_id})
        _ef_name_map = {}
        if _ef_ids:
            for ef in db.query(ExcelFile).filter(ExcelFile.id.in_(_ef_ids)).all():
                _ef_name_map[ef.id] = ef.file_name
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
                "file_name": _ef_name_map.get(r.file_id, "") or r.file_name or "",
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
        source_file_name = resolve_export_source_file_name(rows, db)

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


# ===========================================================================
# 模型对话 API
# ===========================================================================
import time as _time


def call_qwen_plus(messages: list) -> str:
    """Mock: qwen-plus 模型调用"""
    _time.sleep(2)
    last_msg = messages[-1]["content"] if messages else ""
    nl = "\n"
    return f"[qwen-plus Mock] 收到消息：{last_msg[:50]}... 这是模拟回复。{nl}{nl}以下是一些补充说明：{nl}1. 这是一个模拟回复，实际使用时会调用真实模型{nl}2. 你可以尝试不同的模型来获取不同的回复风格{nl}3. 支持代码块展示，例如：{nl}```python{nl}def hello():{nl}    print('Hello, World!'){nl}```"


def call_deepseek_chat(messages: list) -> str:
    """Mock: deepseek-chat 模型调用"""
    _time.sleep(2)
    last_msg = messages[-1]["content"] if messages else ""
    nl = "\n"
    return f"[deepseek-chat Mock] 已分析您的问题：{last_msg[:50]}... 这是模拟回复。{nl}{nl}分析过程如下：{nl}- 首先，理解用户意图{nl}- 然后，检索相关知识{nl}- 最后，生成回复{nl}{nl}```json{nl}{{\"status\": \"success\", \"confidence\": 0.95}}{nl}```"


def call_gpt4_mini(messages: list) -> str:
    """Mock: gpt-4.1-mini 模型调用"""
    _time.sleep(2)
    last_msg = messages[-1]["content"] if messages else ""
    nl = "\n"
    return f"[gpt-4.1-mini Mock] 关于'{last_msg[:30]}'的问题，这是模拟回复。{nl}{nl}代码示例：{nl}```javascript{nl}const answer = 'Hello from GPT!';{nl}console.log(answer);{nl}```"


# 模型调用器注册表
MODEL_CALLERS = {
    "qwen-plus": call_qwen_plus,
    "deepseek-chat": call_deepseek_chat,
    "gpt-4.1-mini": call_gpt4_mini,
}


@app.get("/api/chat/models")
async def chat_list_models():
    """返回可用模型列表，从 models/ 目录读取 yaml 文件名"""
    model_names = [f.stem for f in sorted(MODELS_DIR.glob("*.yaml"))]
    return model_names


@app.get("/api/chat/sessions")
async def chat_list_sessions():
    """返回所有会话列表（按 updated_at 倒序）"""
    db = SessionLocal()
    try:
        sessions = (
            db.query(ChatSession)
            .order_by(ChatSession.updated_at.desc())
            .all()
        )
        return [
            {
                "id": s.id,
                "model_name": s.model_name,
                "title": s.title,
                "created_at": s.created_at.isoformat() if s.created_at else None,
                "updated_at": s.updated_at.isoformat() if s.updated_at else None,
            }
            for s in sessions
        ]
    finally:
        db.close()


@app.post("/api/chat/sessions")
async def chat_create_session(request: Request):
    """创建新会话，需传入 model_name"""
    body = await request.json()
    model_name = body.get("model_name", "")
    if not model_name:
        raise HTTPException(status_code=400, detail="model_name 不能为空")

    session_id = str(uuid4())
    session = ChatSession(id=session_id, model_name=model_name)
    db = SessionLocal()
    try:
        db.add(session)
        db.commit()
        db.refresh(session)
        return {
            "id": session.id,
            "model_name": session.model_name,
            "title": session.title,
            "created_at": session.created_at.isoformat() if session.created_at else None,
            "updated_at": session.updated_at.isoformat() if session.updated_at else None,
        }
    finally:
        db.close()


@app.get("/api/chat/sessions/{session_id}/messages")
async def chat_get_messages(session_id: str):
    """返回该会话所有消息"""
    db = SessionLocal()
    try:
        messages = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at.asc())
            .all()
        )
        return [
            {
                "id": m.id,
                "session_id": m.session_id,
                "role": m.role,
                "content": m.content,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in messages
        ]
    finally:
        db.close()


@app.post("/api/chat/sessions/{session_id}/messages")
async def chat_send_message(session_id: str, request: Request):
    """发送消息并获取AI回复"""
    body = await request.json()
    content = body.get("content", "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    db = SessionLocal()
    try:
        # 查找会话
        session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
        if not session:
            raise HTTPException(status_code=404, detail="会话不存在")

        # 1. 保存用户消息
        user_msg = ChatMessage(session_id=session_id, role="user", content=content)
        db.add(user_msg)
        db.commit()
        db.refresh(user_msg)

        # 2. 获取会话历史构建 messages 列表
        all_messages = (
            db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.created_at.asc())
            .all()
        )
        caller_messages = [{"role": m.role, "content": m.content} for m in all_messages]

        # 3. 调用对应模型获取回复（计时）
        caller = MODEL_CALLERS.get(session.model_name)
        if not caller:
            raise HTTPException(status_code=400, detail=f"不支持的模型: {session.model_name}")
        t0 = _time.time()
        ai_reply = caller(caller_messages)
        duration_ms = int((_time.time() - t0) * 1000)

        # 4. 保存AI回复消息
        assistant_msg = ChatMessage(session_id=session_id, role="assistant", content=ai_reply)
        db.add(assistant_msg)

        # 5. 首次消息时自动设置会话标题（取用户首条消息前20字符）
        if not session.title:
            session.title = content[:20]

        # 更新 session 的 updated_at
        session.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(assistant_msg)

        return {
            "user_message": {
                "id": user_msg.id,
                "session_id": user_msg.session_id,
                "role": user_msg.role,
                "content": user_msg.content,
                "created_at": user_msg.created_at.isoformat() if user_msg.created_at else None,
            },
            "assistant_message": {
                "id": assistant_msg.id,
                "session_id": assistant_msg.session_id,
                "role": assistant_msg.role,
                "content": assistant_msg.content,
                "created_at": assistant_msg.created_at.isoformat() if assistant_msg.created_at else None,
                "duration_ms": duration_ms,
            },
        }
    finally:
        db.close()


@app.delete("/api/chat/sessions/{session_id}")
async def chat_delete_session(session_id: str):
    """删除会话及所有消息"""
    db = SessionLocal()
    try:
        session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
        if not session:
            raise HTTPException(status_code=404, detail="会话不存在")
        # 先删除该会话所有消息
        db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
        db.delete(session)
        db.commit()
        return {"detail": "删除成功"}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 任务管理 API（二级页面专用）
# ---------------------------------------------------------------------------
@app.get("/api/tasks")
async def list_tasks(
    file_id: int = Query(...),
    page: int = Query(1, ge=1),
    size: int = Query(10, ge=1, le=100),
):
    """返回指定文件的标注任务列表（分页，按创建时间倒序）"""
    db = SessionLocal()
    try:
        query = db.query(AnnotationTask).filter(AnnotationTask.file_id == file_id)
        total = query.count()
        tasks = (
            query.order_by(AnnotationTask.created_at.desc())
            .offset((page - 1) * size)
            .limit(size)
            .all()
        )
        items = []
        for t in tasks:
            item = {
                "id": t.id,
                "model_name": t.model_name,
                "strategy": t.strategy,
                "concurrency": t.concurrency,
                "prompt_names": json.loads(t.prompt_names) if t.prompt_names else [],
                "total_rows": t.total_rows,
                "success_count": t.success_count,
                "failed_count": t.failed_count,
                "accuracy": calc_task_stats(str(t.id), db).get("accuracy"),
                "recall": calc_task_stats(str(t.id), db).get("recall"),
                "precision": calc_task_stats(str(t.id), db).get("precision"),
                "f1_score": calc_task_stats(str(t.id), db).get("f1_score"),
                "status": t.status,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "finished_at": t.finished_at.isoformat() if t.finished_at else None,
            }
            # 运行中的任务实时统计进度
            if t.status == "running":
                # 已完成数：有标注结果（非error）的不重复 row_id 数量
                completed_count = (
                    db.query(func.count(distinct(AnnotationResult.row_id)))
                    .filter(AnnotationResult.task_id == t.id)
                    .filter(AnnotationResult.prompt_name != "__error__")
                    .scalar() or 0
                )
                # 标注中数：从内存读取
                with TASK_CURRENT_ROWS_LOCK:
                    annotating_count = len(TASK_CURRENT_ROWS.get(str(t.id), set()))
                # 失败数：标注结果中 prompt_name == '__error__' 的不重复 row_id 数量
                failed_rows = (
                    db.query(func.count(distinct(AnnotationResult.row_id)))
                    .filter(AnnotationResult.task_id == t.id)
                    .filter(AnnotationResult.prompt_name == "__error__")
                    .scalar() or 0
                )
                # 排队中数 = 总行数 - 已完成 - 标注中 - 失败
                queuing_count = max(0, (t.total_rows or 0) - completed_count - annotating_count - failed_rows)
                item["annotating_count"] = annotating_count
                item["completed_count"] = completed_count
                item["queuing_count"] = queuing_count
            items.append(item)
        return {"items": items, "total": total, "page": page, "size": size}
    finally:
        db.close()


@app.get("/api/tasks/compare")
async def compare_tasks(
    task_ids: str = Query(..., description="逗号分隔的两个任务ID"),
):
    """对比两个任务的指标差异"""
    id_list = [tid.strip() for tid in task_ids.split(",") if tid.strip()]
    if len(id_list) != 2:
        raise HTTPException(status_code=400, detail="需要恰好两个任务ID进行对比")

    db = SessionLocal()
    try:
        tasks = db.query(AnnotationTask).filter(AnnotationTask.id.in_(id_list)).all()
        if len(tasks) != 2:
            raise HTTPException(status_code=404, detail="未找到对应的任务")

        # 按 id_list 的顺序排列
        task_map = {t.id: t for t in tasks}
        task_a = task_map.get(id_list[0])
        task_b = task_map.get(id_list[1])
        if not task_a or not task_b:
            raise HTTPException(status_code=404, detail="未找到对应的任务")

        def _task_stats(t: AnnotationTask) -> dict:
            _s = calc_task_stats(str(t.id), db)
            return {
                "id": t.id,
                "model_name": t.model_name,
                "strategy": t.strategy,
                "prompt_names": json.loads(t.prompt_names) if t.prompt_names else [],
                "total_rows": t.total_rows,
                "success_count": t.success_count,
                "failed_count": t.failed_count,
                "accuracy": _s.get("accuracy"),
                "recall": _s.get("recall"),
                "precision": _s.get("precision"),
                "f1_score": _s.get("f1_score"),
                "status": t.status,
            }

        stats_a = _task_stats(task_a)
        stats_b = _task_stats(task_b)

        # 计算指标差异（a - b）
        diff = {}
        for key in ["accuracy", "recall", "precision", "f1_score"]:
            val_a = stats_a[key] if stats_a[key] is not None else 0
            val_b = stats_b[key] if stats_b[key] is not None else 0
            diff[f"{key}_diff"] = round(val_a - val_b, 4)

        return {
            "task_a": stats_a,
            "task_b": stats_b,
            "diff": diff,
        }
    finally:
        db.close()


@app.get("/api/tasks/{task_id}/detail")
async def task_detail(
    task_id: str,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    """返回该任务的逐行标注结果（分页）"""
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")

        # 从 annotation_results 统计 TP/TN/FP/FN/UNKNOWN 及已标注数
        all_results = db.query(AnnotationResult).filter(AnnotationResult.task_id == task_id).all()
        annotated_count = len([r for r in all_results if r.match_type is not None])
        tp_count = sum(1 for r in all_results if r.match_type == "TP")
        tn_count = sum(1 for r in all_results if r.match_type == "TN")
        fp_count = sum(1 for r in all_results if r.match_type == "FP")
        fn_count = sum(1 for r in all_results if r.match_type == "FN")
        unknown_count = sum(1 for r in all_results if r.match_type == "UNKNOWN")
        # 成功/失败数：没有 error 的为成功，有 error 的为失败
        success_count = task.success_count if task.success_count else sum(1 for r in all_results if not r.error)
        failed_count = task.failed_count if task.failed_count else sum(1 for r in all_results if r.error)
        # 任务总耗时（ms）：从 started_at 到 finished_at
        total_duration_ms = None
        if task.started_at and task.finished_at:
            total_duration_ms = int((task.finished_at - task.started_at).total_seconds() * 1000)
        elif task.duration_ms:
            total_duration_ms = task.duration_ms

        # 任务基本信息
        _task_dyn_stats = calc_task_stats(str(task.id), db)
        task_info = {
            "id": task.id,
            "file_id": task.file_id,
            "scene_id": task.scene_id,
            "model_name": task.model_name,
            "strategy": task.strategy,
            "prompt_names": json.loads(task.prompt_names) if task.prompt_names else [],
            "concurrency": task.concurrency,
            "total_rows": task.total_rows,
            "annotated_count": annotated_count,
            "success_count": success_count,
            "failed_count": failed_count,
            "accuracy": _task_dyn_stats.get("accuracy"),
            "recall": _task_dyn_stats.get("recall"),
            "precision": _task_dyn_stats.get("precision"),
            "f1_score": _task_dyn_stats.get("f1_score"),
            "tp_count": tp_count,
            "tn_count": tn_count,
            "fp_count": fp_count,
            "fn_count": fn_count,
            "unknown_count": unknown_count,
            "total_duration_ms": total_duration_ms,
            "status": task.status,
            "created_at": task.created_at.isoformat() if task.created_at else None,
            "finished_at": task.finished_at.isoformat() if task.finished_at else None,
        }

        # 获取当前任务的 current_row_id（运行中的当前标注行）
        task_current_row_id = task.current_row_id
        task_status = task.status

        # 构建已有标注结果的 row_id -> result 映射
        all_results_map = {}  # row_id -> AnnotationResult
        for r in all_results:
            if r.row_id and r.row_id not in all_results_map:
                all_results_map[r.row_id] = r

        # 如果任务运行中，需要展示所有关联行（包括未标注的）
        if task_status in ('running', 'pending'):
            # 获取任务关联的所有行 ID
            specified_row_ids = []
            if task.row_data:
                try:
                    parsed = json.loads(task.row_data)
                    if isinstance(parsed, list):
                        specified_row_ids = parsed
                except Exception:
                    pass

            if specified_row_ids:
                row_query = db.query(ExcelRow).filter(ExcelRow.id.in_(specified_row_ids))
            else:
                row_query = db.query(ExcelRow).filter(ExcelRow.file_id == task.file_id)

            total = row_query.count()
            excel_rows = (
                row_query.order_by(ExcelRow.row_index.asc())
                .offset((page - 1) * size)
                .limit(size)
                .all()
            )

            items = []
            for excel_row in excel_rows:
                r = all_results_map.get(excel_row.id)
                data_dict = json.loads(excel_row.data) if excel_row.data else {}

                # 计算标注状态
                if r is not None and r.match_type is not None:
                    ann_status = '已标注'
                else:
                    # 支持 current_row_id 为 JSON 数组和单值两种格式
                    current_ids = []
                    if task_current_row_id is not None:
                        try:
                            parsed = json.loads(str(task_current_row_id))
                            current_ids = parsed if isinstance(parsed, list) else [parsed]
                        except (json.JSONDecodeError, TypeError, ValueError):
                            current_ids = [task_current_row_id]
                    if excel_row.id in current_ids:
                        ann_status = '标注中'
                    else:
                        ann_status = '排队中'

                items.append({
                    "row_id": excel_row.id,
                    "row_index": excel_row.row_index,
                    "data": data_dict,
                    "human_answer": excel_row.human_answer,
                    "label": r.label if r else None,
                    "merged_label": r.merged_label if r else None,
                    "match_type": r.match_type if r else None,
                    "prompt_name": r.prompt_name if r else None,
                    "duration_ms": r.duration_ms if r else None,
                    "result": json.loads(r.result) if r and r.result else None,
                    "error": r.error if r else None,
                    "annotation_status": ann_status,
                })
        else:
            # 已完成的任务：只查标注结果表
            result_query = db.query(AnnotationResult).filter(AnnotationResult.task_id == task_id)
            total = result_query.count()
            results = (
                result_query.order_by(AnnotationResult.id.asc())
                .offset((page - 1) * size)
                .limit(size)
                .all()
            )

            items = []
            for r in results:
                excel_row = db.query(ExcelRow).filter(ExcelRow.id == r.row_id).first() if r.row_id else None
                data_dict = json.loads(excel_row.data) if excel_row and excel_row.data else {}
                human_answer = excel_row.human_answer if excel_row else None
                row_index = excel_row.row_index if excel_row else None

                # 已完成任务的标注状态
                if r.error:
                    ann_status = '失败'
                elif r.match_type is not None:
                    ann_status = '已标注'
                else:
                    ann_status = '未标注'

                items.append({
                    "row_id": r.row_id,
                    "row_index": row_index,
                    "data": data_dict,
                    "human_answer": human_answer,
                    "label": r.label,
                    "merged_label": r.merged_label,
                    "match_type": r.match_type,
                    "prompt_name": r.prompt_name,
                    "duration_ms": r.duration_ms,
                    "result": json.loads(r.result) if r.result else None,
                    "error": r.error,
                    "annotation_status": ann_status,
                })

        # 将 task_status 和 current_row_id 写入 task_info
        task_info["task_status"] = task_status
        task_info["current_row_id"] = task_current_row_id

        return {
            "task_info": task_info,
            "status": task_status,
            "items": items,
            "total": total,
            "page": page,
            "size": size,
        }
    finally:
        db.close()


@app.delete("/api/tasks/batch")
async def batch_delete_tasks(request: Request):
    """批量删除任务及其所有标注结果"""
    body = await request.json()
    task_ids = body.get("task_ids", [])
    if not task_ids:
        raise HTTPException(status_code=400, detail="task_ids 不能为空")

    db = SessionLocal()
    try:
        deleted = []
        for tid in task_ids:
            task = db.query(AnnotationTask).filter(AnnotationTask.id == tid).first()
            if not task:
                continue
            # 如果任务正在运行/等待中，先取消
            if task.status in TASK_ACTIVE_STATUSES:
                task.status = "cancelled"
                task.finished_at = datetime.utcnow()
                forget_annotation_tasks([tid])
                schedule_pending_annotation_tasks()
            # 删除该任务的所有标注结果
            db.query(AnnotationResult).filter(AnnotationResult.task_id == tid).delete()
            db.delete(task)
            deleted.append(tid)
        db.commit()
        schedule_pending_annotation_tasks()
        return {"detail": "批量删除成功", "deleted_ids": deleted}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()


@app.post("/api/tasks/{task_id}/rerun")
async def rerun_task(task_id: str):
    """以相同配置创建新任务并执行"""
    db = SessionLocal()
    try:
        orig = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not orig:
            raise HTTPException(status_code=404, detail="原任务不存在")

        # 从原任务复制配置
        new_task_id = str(uuid4())
        model_display_name = orig.model_name
        new_task = AnnotationTask(
            id=new_task_id,
            file_id=orig.file_id,
            scene_id=orig.scene_id,
            model_name=model_display_name,
            model_config=orig.model_config,
            strategy=orig.strategy,
            concurrency=orig.concurrency,
            total_rows=orig.total_rows,
            prompt_names=orig.prompt_names,
            row_data=orig.row_data,
            status="pending",
        )
        db.add(new_task)
        db.commit()

        # 调度执行
        with TASK_SCHEDULER_LOCK:
            if len(TASK_RUNNING_IDS) < MAX_TASK_CONCURRENCY:
                combo_limit = min(clamp_task_concurrency(orig.concurrency), MAX_ACTIVE_TASKS_PER_COMBO)
                if TASK_ACTIVE_BY_COMBO[model_display_name] < combo_limit:
                    new_task.status = "running"
                    new_task.started_at = datetime.utcnow()
                    TASK_RUNNING_IDS.add(new_task_id)
                    TASK_ACTIVE_BY_COMBO[model_display_name] += 1
                    db.commit()
                    TASK_EXECUTOR.submit(execute_workbench_annotation_task, new_task_id)
        schedule_pending_annotation_tasks()

        return {"task_id": new_task_id, "status": "pending", "total_rows": orig.total_rows}
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str):
    """删除任务及其所有标注结果"""
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")

        # 如果任务正在运行/等待中，先取消
        if task.status in TASK_ACTIVE_STATUSES:
            task.status = "cancelled"
            task.finished_at = datetime.utcnow()
            forget_annotation_tasks([task_id])
            schedule_pending_annotation_tasks()

        # 删除该任务的所有标注结果
        db.query(AnnotationResult).filter(AnnotationResult.task_id == task_id).delete()
        # 删除任务本身
        db.delete(task)
        db.commit()
        return {"detail": "删除成功", "task_id": task_id}
    except HTTPException:
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API — 全局统计（统计页面专用）
# ---------------------------------------------------------------------------
@app.get("/api/statistics")
async def get_global_statistics(scene_id: Optional[int] = Query(None)):
    """
    返回全局标注统计汇总，包括：
      - scenes_summary: 按场景汇总（文件数/总行数/任务数/平均准确率）
      - models_summary: 按模型汇总（任务数/平均准确率/平均查全率/平均F1）
      - strategies_summary: 按策略汇总（任务数/平均准确率）
      - recent_tasks: 最近10个已完成任务
    """
    db = SessionLocal()
    try:
        # 构建任务查询基线（支持按场景过滤）
        task_base_query = db.query(AnnotationTask).filter(
            AnnotationTask.status == "success",
            AnnotationTask.accuracy.isnot(None),
        )
        if scene_id:
            task_base_query = task_base_query.filter(AnnotationTask.scene_id == scene_id)
        completed_tasks = task_base_query.all()

        # ===== 场景汇总 =====
        # 每个场景的文件数、总行数、任务数、平均准确率
        scenes_list = db.query(Scene).order_by(Scene.id).all()
        scenes_summary = []
        for scene in scenes_list:
            # 文件数
            scene_file_count = db.query(ExcelFile).filter(ExcelFile.scene_id == scene.id).count()
            # 总行数
            scene_total_rows = (
                db.query(func.sum(ExcelFile.total_rows))
                .filter(ExcelFile.scene_id == scene.id)
                .scalar() or 0
            )
            # 该场景已完成任务
            scene_completed_tasks = [
                t for t in completed_tasks if t.scene_id == scene.id
            ]
            scene_task_count = len(scene_completed_tasks)
            # 平均准确率（排除 None）
            scene_accuracy_values = [
                t.accuracy for t in scene_completed_tasks if t.accuracy is not None
            ]
            scene_avg_accuracy = (
                round(sum(scene_accuracy_values) / len(scene_accuracy_values), 4)
                if scene_accuracy_values else None
            )
            scenes_summary.append({
                "scene_id": scene.id,
                "scene_name": scene.name,
                "total_files": scene_file_count,
                "total_rows": scene_total_rows,
                "total_tasks": scene_task_count,
                "avg_accuracy": scene_avg_accuracy,
            })

        # ===== 模型汇总 =====
        # 按模型名称分组计算平均准确率、查全率、F1
        models_summary_map: Dict[str, dict] = {}
        for task in completed_tasks:
            model_name = task.model_name or "未知模型"
            if model_name not in models_summary_map:
                models_summary_map[model_name] = {
                    "model_name": model_name,
                    "task_count": 0,
                    "accuracy_values": [],
                    "recall_values": [],
                    "f1_values": [],
                }
            models_summary_map[model_name]["task_count"] += 1
            if task.accuracy is not None:
                models_summary_map[model_name]["accuracy_values"].append(task.accuracy)
            if task.recall is not None:
                models_summary_map[model_name]["recall_values"].append(task.recall)
            if task.f1_score is not None:
                models_summary_map[model_name]["f1_values"].append(task.f1_score)

        def calc_avg(values: list) -> Optional[float]:
            """计算平均値，排除 None"""
            return round(sum(values) / len(values), 4) if values else None

        models_summary = []
        for model_stats in sorted(models_summary_map.values(), key=lambda x: x["task_count"], reverse=True):
            models_summary.append({
                "model_name": model_stats["model_name"],
                "task_count": model_stats["task_count"],
                "avg_accuracy": calc_avg(model_stats["accuracy_values"]),
                "avg_recall": calc_avg(model_stats["recall_values"]),
                "avg_f1": calc_avg(model_stats["f1_values"]),
            })

        # ===== 策略汇总 =====
        strategies_summary_map: Dict[str, dict] = {}
        for task in completed_tasks:
            strategy_name = task.strategy or "默认策略"
            if strategy_name not in strategies_summary_map:
                strategies_summary_map[strategy_name] = {
                    "strategy": strategy_name,
                    "task_count": 0,
                    "accuracy_values": [],
                }
            strategies_summary_map[strategy_name]["task_count"] += 1
            if task.accuracy is not None:
                strategies_summary_map[strategy_name]["accuracy_values"].append(task.accuracy)

        strategies_summary = []
        for strategy_stats in sorted(strategies_summary_map.values(), key=lambda x: x["task_count"], reverse=True):
            strategies_summary.append({
                "strategy": strategy_stats["strategy"],
                "task_count": strategy_stats["task_count"],
                "avg_accuracy": calc_avg(strategy_stats["accuracy_values"]),
            })

        # ===== 最近任务（最近10个已完成任务）=====
        recent_tasks_query = (
            db.query(AnnotationTask)
            .filter(AnnotationTask.status == "success")
        )
        if scene_id:
            recent_tasks_query = recent_tasks_query.filter(AnnotationTask.scene_id == scene_id)
        recent_completed_tasks = (
            recent_tasks_query
            .order_by(AnnotationTask.created_at.desc())
            .limit(10)
            .all()
        )
        recent_tasks = [
            {
                "id": t.id,
                "model_name": t.model_name or "",
                "strategy": t.strategy or "",
                "accuracy": t.accuracy,
                "recall": t.recall,
                "f1_score": t.f1_score,
                "total_rows": t.total_rows or 0,
                "success_count": t.success_count or 0,
                "created_at": t.created_at.isoformat() if t.created_at else None,
                "finished_at": t.finished_at.isoformat() if t.finished_at else None,
            }
            for t in recent_completed_tasks
        ]

        # ===== 概览卡片汇总数据 =====
        total_scene_count = len(scenes_list)
        total_file_count = db.query(ExcelFile).count()
        total_task_count = db.query(AnnotationTask).filter(AnnotationTask.status == "success").count()
        all_accuracy_values = [t.accuracy for t in completed_tasks if t.accuracy is not None]
        overall_avg_accuracy = calc_avg(all_accuracy_values)

        return {
            "overview": {
                "total_scenes": total_scene_count,
                "total_files": total_file_count,
                "total_tasks": total_task_count,
                "avg_accuracy": overall_avg_accuracy,
            },
            "scenes_summary": scenes_summary,
            "models_summary": models_summary,
            "strategies_summary": strategies_summary,
            "recent_tasks": recent_tasks,
        }
    finally:
        db.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=5001)


# ---------------------------------------------------------------------------
# API — 全局 DB→本地文件同步
# ---------------------------------------------------------------------------
@app.get("/api/sync/status")
async def get_sync_status():
    """查询当前同步状态"""
    with SYNC_LOCK:
        return {
            "status": SYNC_STATUS["status"],
            "last_sync_time": SYNC_STATUS["last_sync_time"],
        }


@app.post("/api/sync/trigger")
async def trigger_sync():
    """手动触发一次 DB→本地文件同步（非阻塞，后台线程执行）"""
    with SYNC_LOCK:
        if SYNC_STATUS["status"] == "syncing":
            return {"success": False, "message": "同步正在进行中，请稍后"}
    t = _threading.Thread(target=_sync_all_db_to_local, daemon=True)
    t.start()
    return {"success": True, "message": "同步已触发"}
