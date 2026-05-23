"""
数据飞轮 Prompt 标注调试台 — FastAPI 后端
"""

import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from io import BytesIO
from pathlib import Path
from string import Template
from typing import Any, Optional
from urllib.parse import quote
from uuid import uuid4

import pandas as pd
import yaml
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, create_engine, inspect
from sqlalchemy.orm import declarative_base, sessionmaker

from strategies import STRATEGIES

BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
PROMPTS_DIR = BASE_DIR / "prompts"
KNOWLEDGE_DIR = BASE_DIR / "knowledge"
MODELS_DIR = BASE_DIR / "models"
CONFIG_DIR = BASE_DIR / "config"
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
ASSETS_DIR = FRONTEND_DIST / "assets"

for directory in [UPLOADS_DIR, PROMPTS_DIR, KNOWLEDGE_DIR, MODELS_DIR, CONFIG_DIR]:
    directory.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{BASE_DIR / 'db.sqlite'}"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

MAX_TASK_CONCURRENCY = 20
TASK_EXECUTOR = ThreadPoolExecutor(max_workers=MAX_TASK_CONCURRENCY)
TASK_ACTIVE_STATUSES = {"pending", "running"}
SCHEMA_VERSION = "prd_v2"


class AppMeta(Base):
    __tablename__ = "app_meta"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)


class Scene(Base):
    __tablename__ = "scenes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_id = Column(Integer, nullable=True)
    name = Column(String, nullable=False)
    path = Column(String, nullable=False, default="")
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class ExcelFile(Base):
    __tablename__ = "excel_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    display_name = Column(String, nullable=False)
    original_file_name = Column(String, nullable=False)
    stored_file_path = Column(String, nullable=False)
    columns_json = Column(Text, nullable=False, default="[]")
    row_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class ExcelRow(Base):
    __tablename__ = "excel_rows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    excel_file_id = Column(Integer, nullable=False)
    row_index = Column(Integer, nullable=False)
    data = Column(Text, nullable=False)
    human_answer = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class PromptAsset(Base):
    __tablename__ = "prompt_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    file_name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    file_path = Column(String, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class AnnotationRole(Base):
    __tablename__ = "annotation_roles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    prompt_id = Column(Integer, nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class KnowledgeAsset(Base):
    __tablename__ = "knowledge_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    file_name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    file_path = Column(String, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class FewshotBook(Base):
    __tablename__ = "fewshot_books"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    cot_name = Column(String, nullable=False, default="")
    name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class RuleAsset(Base):
    __tablename__ = "rule_assets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    name = Column(String, nullable=False)
    file_name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    file_path = Column(String, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class ModelConfig(Base):
    __tablename__ = "model_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    file_name = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    file_path = Column(String, nullable=False, default="")
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class AnnotationResult(Base):
    __tablename__ = "annotation_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(Integer, nullable=False)
    excel_file_id = Column(Integer, nullable=False)
    row_id = Column(Integer, nullable=False)
    model_config_id = Column(Integer, nullable=True)
    role_ids_json = Column(Text, nullable=False, default="[]")
    model_name = Column(String, nullable=False)
    final_label = Column(String, nullable=True)
    match_type = Column(String, nullable=False, default="UNKNOWN")
    role_results_json = Column(Text, nullable=False, default="[]")
    prompt_snapshot_json = Column(Text, nullable=False, default="[]")
    error = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AnnotationTask(Base):
    __tablename__ = "annotation_tasks"

    id = Column(String, primary_key=True)
    scene_id = Column(Integer, nullable=False)
    excel_file_id = Column(Integer, nullable=False)
    row_id = Column(Integer, nullable=False)
    model_config_id = Column(Integer, nullable=False)
    role_ids_json = Column(Text, nullable=False, default="[]")
    status = Column(String, nullable=False, default="pending")
    result = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)


def db_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def now() -> datetime:
    return datetime.utcnow()


def json_loads(value: Optional[str], fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def normalize_binary_label(value: Any) -> str:
    text = str(value or "").strip()
    yes_values = {"是", "对", "正确", "yes", "YES", "true", "True", "1"}
    no_values = {"否", "错", "错误", "no", "NO", "false", "False", "0"}
    if text in yes_values:
        return "是"
    if text in no_values:
        return "否"
    return ""


def calc_match_type(human_answer: Any, label: Any) -> str:
    human = normalize_binary_label(human_answer)
    model = normalize_binary_label(label)
    if human == "是" and model == "是":
        return "TP"
    if human == "是" and model == "否":
        return "FN"
    if human == "否" and model == "是":
        return "FP"
    if human == "否" and model == "否":
        return "TN"
    return "UNKNOWN"


def ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator > 0 else 0


def safe_name(name: str, suffix: str) -> str:
    pure = Path(name or f"asset{suffix}").name
    if not pure.endswith(suffix):
        pure = f"{pure}{suffix}"
    return pure


def read_table(filename: str, content: bytes) -> pd.DataFrame:
    suffix = Path(filename).suffix.lower()
    buffer = BytesIO(content)
    if suffix == ".csv":
        return pd.read_csv(buffer)
    return pd.read_excel(buffer)


def get_rule_dict(db, scene_id: int) -> dict:
    rule = (
        db.query(RuleAsset)
        .filter(RuleAsset.scene_id == scene_id, RuleAsset.enabled == True)  # noqa: E712
        .order_by(RuleAsset.updated_at.desc(), RuleAsset.id.desc())
        .first()
    )
    if rule:
        return json_loads(rule.content, {})
    return default_rule()


def default_rule() -> dict:
    path = CONFIG_DIR / "rule.json"
    if path.exists():
        data = json_loads(path.read_text(encoding="utf-8"), {})
    else:
        data = {}
    data.setdefault("excel_fields", [])
    data.setdefault("annotate_fields", [])
    data.setdefault("answer_field", "人工标注答案")
    data.setdefault("result_label_field", "大模型标注答案")
    data.setdefault("cot_name_field", "")
    return data


def build_scene_path(db, scene: Scene) -> str:
    names = [scene.name]
    parent_id = scene.parent_id
    while parent_id:
        parent = db.query(Scene).filter(Scene.id == parent_id).first()
        if not parent:
            break
        names.append(parent.name)
        parent_id = parent.parent_id
    return " / ".join(reversed(names))


def sync_scene_paths(db):
    for scene in db.query(Scene).all():
        scene.path = build_scene_path(db, scene)
        scene.updated_at = now()
    db.commit()


def ensure_schema():
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    valid = False
    if "app_meta" in existing_tables:
        db = SessionLocal()
        try:
            meta = db.query(AppMeta).filter(AppMeta.key == "schema_version").first()
            valid = bool(meta and meta.value == SCHEMA_VERSION)
        finally:
            db.close()
    if not valid:
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        seed_database()


def seed_database():
    db = SessionLocal()
    try:
        db.add(AppMeta(key="schema_version", value=SCHEMA_VERSION))
        root = Scene(name="默认场景", parent_id=None, path="默认场景", sort_order=1)
        db.add(root)
        db.flush()

        rule_content = json_dumps(default_rule())
        rule_file = CONFIG_DIR / "rule.json"
        db.add(RuleAsset(
            scene_id=root.id,
            name="默认规则",
            file_name=rule_file.name,
            content=rule_content,
            file_path=str(rule_file),
        ))

        for prompt_file in sorted(list(PROMPTS_DIR.glob("*.prompt")) + list(PROMPTS_DIR.glob("*.txt"))):
            content = prompt_file.read_text(encoding="utf-8")
            prompt = PromptAsset(
                scene_id=root.id,
                name=prompt_file.stem,
                file_name=prompt_file.name,
                content=content,
                file_path=str(prompt_file),
            )
            db.add(prompt)
            db.flush()
            db.add(AnnotationRole(
                scene_id=root.id,
                name=prompt_file.stem,
                prompt_id=prompt.id,
                sort_order=prompt.id,
            ))

        for knowledge_file in sorted(KNOWLEDGE_DIR.glob("*")):
            if knowledge_file.suffix.lower() not in {".txt", ".json", ".jsonl"}:
                continue
            db.add(KnowledgeAsset(
                scene_id=root.id,
                name=knowledge_file.stem,
                file_name=knowledge_file.name,
                content=knowledge_file.read_text(encoding="utf-8"),
                file_path=str(knowledge_file),
            ))

        for model_file in sorted(MODELS_DIR.glob("*.yaml")):
            db.add(ModelConfig(
                name=model_file.stem,
                file_name=model_file.name,
                content=model_file.read_text(encoding="utf-8"),
                file_path=str(model_file),
            ))
        db.commit()
    finally:
        db.close()


ensure_schema()

app = FastAPI(title="数据飞轮 Prompt 标注调试台")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")


def scene_payload(scene: Scene) -> dict:
    return {
        "id": scene.id,
        "parent_id": scene.parent_id,
        "name": scene.name,
        "path": scene.path,
        "sort_order": scene.sort_order,
        "created_at": scene.created_at.isoformat() if scene.created_at else None,
        "updated_at": scene.updated_at.isoformat() if scene.updated_at else None,
    }


def asset_payload(asset) -> dict:
    payload = {
        "id": asset.id,
        "scene_id": getattr(asset, "scene_id", None),
        "name": asset.name,
        "enabled": bool(getattr(asset, "enabled", True)),
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
        "updated_at": asset.updated_at.isoformat() if asset.updated_at else None,
    }
    for attr in ["file_name", "content", "file_path", "prompt_id", "cot_name", "sort_order"]:
        if hasattr(asset, attr):
            payload[attr] = getattr(asset, attr)
    return payload


def row_payload(row: ExcelRow, db) -> dict:
    result = (
        db.query(AnnotationResult)
        .filter(AnnotationResult.row_id == row.id)
        .order_by(AnnotationResult.created_at.desc())
        .first()
    )
    return {
        "id": row.id,
        "scene_id": row.scene_id,
        "excel_file_id": row.excel_file_id,
        "row_index": row.row_index,
        "data": json_loads(row.data, {}),
        "human_answer": row.human_answer,
        "annotation": result_payload(result) if result else None,
    }


def result_payload(result: Optional[AnnotationResult]) -> Optional[dict]:
    if not result:
        return None
    return {
        "id": result.id,
        "scene_id": result.scene_id,
        "excel_file_id": result.excel_file_id,
        "row_id": result.row_id,
        "model_config_id": result.model_config_id,
        "role_ids": json_loads(result.role_ids_json, []),
        "model_name": result.model_name,
        "final_label": result.final_label,
        "match_type": result.match_type,
        "role_results": json_loads(result.role_results_json, []),
        "prompt_snapshot": json_loads(result.prompt_snapshot_json, []),
        "error": result.error,
        "duration_ms": result.duration_ms,
        "created_at": result.created_at.isoformat() if result.created_at else None,
    }


def task_payload(task: AnnotationTask) -> dict:
    return {
        "id": task.id,
        "scene_id": task.scene_id,
        "excel_file_id": task.excel_file_id,
        "row_id": task.row_id,
        "model_config_id": task.model_config_id,
        "role_ids": json_loads(task.role_ids_json, []),
        "status": task.status,
        "result": json_loads(task.result, None),
        "error": task.error,
        "duration_ms": task.duration_ms,
        "created_at": task.created_at.isoformat() if task.created_at else None,
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "finished_at": task.finished_at.isoformat() if task.finished_at else None,
    }


def write_asset_file(directory: Path, file_name: str, content: str) -> str:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / Path(file_name).name
    path.write_text(content or "", encoding="utf-8")
    return str(path)


def render_prompt(template: str, context: dict) -> str:
    rendered = template or ""
    for key, value in context.items():
        rendered = rendered.replace("{{" + key + "}}", str(value))
    try:
        rendered = Template(rendered).safe_substitute(context)
    except Exception:
        pass
    return rendered


def get_strategy_fn():
    return STRATEGIES.get("方案A") or next(iter(STRATEGIES.values()))


def call_single_role(prompt: str, row_data: dict, model_name: str, role_name: str, knowledge_items: list) -> dict:
    strategy = get_strategy_fn()
    prompt_list = [{"name": role_name, "content": prompt}]
    return strategy(prompt, row_data, model_name, prompt_list, 1, knowledge_items)


def annotation_model_name(model: ModelConfig, roles: list[AnnotationRole]) -> str:
    role_names = "+".join([role.name for role in roles])
    return f"{model.name}({role_names})"


def process_annotation(task_id: str):
    started = now()
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task or task.status == "cancelled":
            return
        task.status = "running"
        task.started_at = started
        db.commit()

        row = db.query(ExcelRow).filter(ExcelRow.id == task.row_id).first()
        scene = db.query(Scene).filter(Scene.id == task.scene_id).first()
        model = db.query(ModelConfig).filter(ModelConfig.id == task.model_config_id).first()
        role_ids = json_loads(task.role_ids_json, [])
        roles = db.query(AnnotationRole).filter(AnnotationRole.id.in_(role_ids), AnnotationRole.enabled == True).all()  # noqa: E712
        if not row or not scene or not model or not roles:
            raise ValueError("标注任务缺少行、场景、模型或角色")

        rule = get_rule_dict(db, task.scene_id)
        result_label_field = rule.get("result_label_field", "大模型标注答案")
        cot_field = rule.get("cot_name_field", "")
        row_data = json_loads(row.data, {})
        cot_name = str(row_data.get(cot_field, "") if cot_field else "")
        knowledge_items = [
            {"name": item.name, "content": item.content}
            for item in db.query(KnowledgeAsset).filter(KnowledgeAsset.scene_id == task.scene_id, KnowledgeAsset.enabled == True).all()  # noqa: E712
        ]
        knowledge_text = "\n\n".join([item["content"] for item in knowledge_items])
        fewshot_items = (
            db.query(FewshotBook)
            .filter(FewshotBook.scene_id == task.scene_id, FewshotBook.enabled == True)  # noqa: E712
            .all()
        )
        fewshot_text = "\n\n".join([item.content for item in fewshot_items if not cot_name or item.cot_name == cot_name])
        context = {
            "knowledge": knowledge_text,
            "rule": json_dumps(rule),
            "fewshots": fewshot_text,
            "cot_name": cot_name,
            "scene_name": scene.path,
            "row_data": json_dumps(row_data),
        }

        role_results = []
        prompt_snapshots = []
        errors = []
        labels = []
        model_name = annotation_model_name(model, roles)
        for role in roles:
            prompt_asset = db.query(PromptAsset).filter(PromptAsset.id == role.prompt_id, PromptAsset.scene_id == task.scene_id).first()
            if not prompt_asset:
                errors.append(f"{role.name}: prompt not found")
                continue
            full_prompt = render_prompt(prompt_asset.content, context)
            prompt_snapshots.append({"role_id": role.id, "role_name": role.name, "prompt": full_prompt})
            try:
                raw_result = call_single_role(full_prompt, row_data, model.file_name, role.name, knowledge_items)
                raw_label = raw_result.get(result_label_field)
                label = normalize_binary_label(raw_label)
                if not label:
                    errors.append(f"{role.name}: missing or invalid {result_label_field}")
                else:
                    labels.append(label)
                role_results.append({
                    "role_id": role.id,
                    "role_name": role.name,
                    "label": label or "",
                    "raw_result": raw_result,
                    "error": "" if label else f"missing or invalid {result_label_field}",
                })
            except Exception as exc:
                errors.append(f"{role.name}: {exc}")
                role_results.append({
                    "role_id": role.id,
                    "role_name": role.name,
                    "label": "",
                    "raw_result": {},
                    "error": str(exc),
                })

        if errors or len(labels) != len(roles):
            final_label = ""
            match_type = "UNKNOWN"
        else:
            final_label = "是" if all(label == "是" for label in labels) else "否"
            match_type = calc_match_type(row.human_answer, final_label)

        finished = now()
        duration_ms = int((finished - started).total_seconds() * 1000)
        existing = (
            db.query(AnnotationResult)
            .filter(
                AnnotationResult.row_id == row.id,
                AnnotationResult.model_config_id == model.id,
                AnnotationResult.role_ids_json == json_dumps(role_ids),
            )
            .first()
        )
        if not existing:
            existing = AnnotationResult(
                scene_id=task.scene_id,
                excel_file_id=task.excel_file_id,
                row_id=row.id,
                model_config_id=model.id,
                role_ids_json=json_dumps(role_ids),
                model_name=model_name,
            )
            db.add(existing)
        existing.final_label = final_label
        existing.match_type = match_type
        existing.role_results_json = json_dumps(role_results)
        existing.prompt_snapshot_json = json_dumps(prompt_snapshots)
        existing.error = "\n".join(errors) if errors else ""
        existing.duration_ms = duration_ms
        existing.created_at = finished
        db.flush()

        task.status = "success"
        task.result = json_dumps(result_payload(existing))
        task.error = existing.error
        task.duration_ms = duration_ms
        task.finished_at = finished
        db.commit()
    except Exception as exc:
        db.rollback()
        finished = now()
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if task:
            task.status = "failed"
            task.error = str(exc)
            task.duration_ms = int((finished - started).total_seconds() * 1000)
            task.finished_at = finished
            db.commit()
    finally:
        db.close()


def enqueue_task(task: AnnotationTask):
    TASK_EXECUTOR.submit(process_annotation, task.id)


@app.get("/api/scenes")
def list_scenes():
    db = SessionLocal()
    try:
        return {"items": [scene_payload(scene) for scene in db.query(Scene).order_by(Scene.path.asc()).all()]}
    finally:
        db.close()


@app.post("/api/scenes")
def create_scene(body: dict = Body(...)):
    db = SessionLocal()
    try:
        scene = Scene(
            name=(body.get("name") or "新场景").strip(),
            parent_id=body.get("parent_id"),
            sort_order=int(body.get("sort_order") or 0),
        )
        db.add(scene)
        db.flush()
        scene.path = build_scene_path(db, scene)
        db.commit()
        return {"item": scene_payload(scene)}
    finally:
        db.close()


@app.put("/api/scenes/{scene_id}")
def update_scene(scene_id: int, body: dict = Body(...)):
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(404, "Scene not found")
        scene.name = (body.get("name") or scene.name).strip()
        scene.parent_id = body.get("parent_id")
        scene.sort_order = int(body.get("sort_order") or scene.sort_order or 0)
        scene.updated_at = now()
        db.commit()
        sync_scene_paths(db)
        db.refresh(scene)
        return {"item": scene_payload(scene)}
    finally:
        db.close()


@app.delete("/api/scenes/{scene_id}")
def delete_scene(scene_id: int):
    db = SessionLocal()
    try:
        child_count = db.query(Scene).filter(Scene.parent_id == scene_id).count()
        if child_count:
            raise HTTPException(400, "请先删除子场景")
        for model in [ExcelFile, ExcelRow, PromptAsset, AnnotationRole, KnowledgeAsset, FewshotBook, RuleAsset, AnnotationTask, AnnotationResult]:
            db.query(model).filter(getattr(model, "scene_id") == scene_id).delete(synchronize_session=False)
        db.query(Scene).filter(Scene.id == scene_id).delete()
        db.commit()
        return {"success": True}
    finally:
        db.close()


@app.get("/api/excels")
def list_excels(scene_id: Optional[int] = None):
    db = SessionLocal()
    try:
        query = db.query(ExcelFile)
        if scene_id:
            query = query.filter(ExcelFile.scene_id == scene_id)
        items = []
        for item in query.order_by(ExcelFile.created_at.desc()).all():
            annotated = db.query(AnnotationResult).filter(AnnotationResult.excel_file_id == item.id).count()
            payload = {
                "id": item.id,
                "scene_id": item.scene_id,
                "display_name": item.display_name,
                "original_file_name": item.original_file_name,
                "columns": json_loads(item.columns_json, []),
                "row_count": item.row_count,
                "annotation_count": annotated,
                "created_at": item.created_at.isoformat() if item.created_at else None,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            }
            items.append(payload)
        return {"items": items}
    finally:
        db.close()


@app.post("/api/excels/upload")
async def upload_excel(scene_id: int = Query(...), display_name: str = Query(""), file: UploadFile = File(...)):
    content = await file.read()
    df = read_table(file.filename, content)
    db = SessionLocal()
    try:
        scene = db.query(Scene).filter(Scene.id == scene_id).first()
        if not scene:
            raise HTTPException(404, "Scene not found")
        stored_name = f"{uuid4().hex}_{Path(file.filename).name}"
        stored_path = UPLOADS_DIR / stored_name
        stored_path.write_bytes(content)
        excel = ExcelFile(
            scene_id=scene_id,
            display_name=display_name or Path(file.filename).stem,
            original_file_name=file.filename,
            stored_file_path=str(stored_path),
            columns_json=json_dumps([str(col) for col in df.columns]),
            row_count=len(df),
        )
        db.add(excel)
        db.flush()
        rule = get_rule_dict(db, scene_id)
        answer_field = rule.get("answer_field", "人工标注答案")
        result_label_field = rule.get("result_label_field", "大模型标注答案")
        for index, row in df.iterrows():
            data = {str(col): (None if pd.isna(row[col]) else row[col]) for col in df.columns}
            human_answer = data.get(answer_field)
            excel_row = ExcelRow(
                scene_id=scene_id,
                excel_file_id=excel.id,
                row_index=int(index) + 1,
                data=json_dumps(data),
                human_answer=str(human_answer).strip() if human_answer is not None else "",
            )
            db.add(excel_row)
            db.flush()
            imported_label = data.get(result_label_field)
            if human_answer is not None and imported_label is not None:
                label = normalize_binary_label(imported_label)
                db.add(AnnotationResult(
                    scene_id=scene_id,
                    excel_file_id=excel.id,
                    row_id=excel_row.id,
                    model_config_id=None,
                    role_ids_json="[]",
                    model_name="imported",
                    final_label=label,
                    match_type=calc_match_type(human_answer, label),
                    role_results_json=json_dumps([{"role_name": "imported", "label": label, "raw_result": data}]),
                    prompt_snapshot_json="[]",
                ))
        db.commit()
        return {"item": {"id": excel.id, "row_count": excel.row_count, "columns": json_loads(excel.columns_json, [])}}
    finally:
        db.close()


@app.get("/api/excels/{excel_id}/rows")
def list_rows(
    excel_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    filters: str = Query("{}"),
):
    db = SessionLocal()
    try:
        excel = db.query(ExcelFile).filter(ExcelFile.id == excel_id).first()
        if not excel:
            raise HTTPException(404, "Excel not found")
        query = db.query(ExcelRow).filter(ExcelRow.excel_file_id == excel_id)
        rows = query.order_by(ExcelRow.id.asc()).all()
        parsed_filters = json_loads(filters, {})
        if parsed_filters:
            def include(row: ExcelRow) -> bool:
                data = json_loads(row.data, {})
                ann = row_payload(row, db).get("annotation") or {}
                for key, value in parsed_filters.items():
                    if value in [None, ""]:
                        continue
                    text = str(value)
                    if key == "id" and text not in str(row.id):
                        return False
                    if key == "match_type" and ann.get("match_type") != value:
                        return False
                    if key == "final_label" and ann.get("final_label") != value:
                        return False
                    if key == "human_answer" and text not in str(row.human_answer or ""):
                        return False
                    if key.startswith("data.") and text not in str(data.get(key.split(".", 1)[1], "")):
                        return False
                return True
            rows = [row for row in rows if include(row)]
        total = len(rows)
        start = (page - 1) * page_size
        page_rows = rows[start:start + page_size]
        return {
            "items": [row_payload(row, db) for row in page_rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "columns": json_loads(excel.columns_json, []),
        }
    finally:
        db.close()


@app.delete("/api/excels/{excel_id}")
def delete_excel(excel_id: int):
    db = SessionLocal()
    try:
        excel = db.query(ExcelFile).filter(ExcelFile.id == excel_id).first()
        if not excel:
            raise HTTPException(404, "Excel not found")
        Path(excel.stored_file_path).unlink(missing_ok=True)
        for model in [ExcelRow, AnnotationResult, AnnotationTask]:
            db.query(model).filter(model.excel_file_id == excel_id).delete(synchronize_session=False)
        db.query(ExcelFile).filter(ExcelFile.id == excel_id).delete()
        db.commit()
        return {"success": True}
    finally:
        db.close()


def crud_list(model, scene_id: Optional[int] = None):
    db = SessionLocal()
    try:
        query = db.query(model)
        if scene_id and hasattr(model, "scene_id"):
            query = query.filter(model.scene_id == scene_id)
        return {"items": [asset_payload(item) for item in query.order_by(model.id.desc()).all()]}
    finally:
        db.close()


def crud_create(model, body: dict, directory: Optional[Path] = None, suffix: str = ".txt"):
    db = SessionLocal()
    try:
        data = dict(body)
        if directory is not None:
            file_name = safe_name(data.get("file_name") or data.get("name"), suffix)
            content = data.get("content", "")
            data["file_name"] = file_name
            data["file_path"] = write_asset_file(directory, file_name, content)
        item = model(**{k: v for k, v in data.items() if hasattr(model, k)})
        db.add(item)
        db.commit()
        db.refresh(item)
        return {"item": asset_payload(item)}
    finally:
        db.close()


def crud_update(model, item_id: int, body: dict, directory: Optional[Path] = None, suffix: str = ".txt"):
    db = SessionLocal()
    try:
        item = db.query(model).filter(model.id == item_id).first()
        if not item:
            raise HTTPException(404, "Item not found")
        for key, value in body.items():
            if hasattr(item, key):
                setattr(item, key, value)
        if directory is not None:
            item.file_name = safe_name(getattr(item, "file_name", "") or item.name, suffix)
            item.file_path = write_asset_file(directory, item.file_name, getattr(item, "content", ""))
        item.updated_at = now()
        db.commit()
        db.refresh(item)
        return {"item": asset_payload(item)}
    finally:
        db.close()


def crud_delete(model, item_id: int):
    db = SessionLocal()
    try:
        item = db.query(model).filter(model.id == item_id).first()
        if not item:
            raise HTTPException(404, "Item not found")
        if hasattr(item, "file_path") and item.file_path:
            Path(item.file_path).unlink(missing_ok=True)
        db.delete(item)
        db.commit()
        return {"success": True}
    finally:
        db.close()


@app.get("/api/prompts")
def list_prompts(scene_id: Optional[int] = None):
    return crud_list(PromptAsset, scene_id)


@app.post("/api/prompts")
def create_prompt(body: dict = Body(...)):
    return crud_create(PromptAsset, body, PROMPTS_DIR, ".prompt")


@app.put("/api/prompts/{item_id}")
def update_prompt(item_id: int, body: dict = Body(...)):
    return crud_update(PromptAsset, item_id, body, PROMPTS_DIR, ".prompt")


@app.delete("/api/prompts/{item_id}")
def delete_prompt(item_id: int):
    return crud_delete(PromptAsset, item_id)


@app.get("/api/roles")
def list_roles(scene_id: Optional[int] = None):
    return crud_list(AnnotationRole, scene_id)


@app.post("/api/roles")
def create_role(body: dict = Body(...)):
    return crud_create(AnnotationRole, body)


@app.put("/api/roles/{item_id}")
def update_role(item_id: int, body: dict = Body(...)):
    return crud_update(AnnotationRole, item_id, body)


@app.delete("/api/roles/{item_id}")
def delete_role(item_id: int):
    return crud_delete(AnnotationRole, item_id)


@app.get("/api/knowledge")
def list_knowledge(scene_id: Optional[int] = None):
    return crud_list(KnowledgeAsset, scene_id)


@app.post("/api/knowledge")
def create_knowledge(body: dict = Body(...)):
    return crud_create(KnowledgeAsset, body, KNOWLEDGE_DIR, ".txt")


@app.put("/api/knowledge/{item_id}")
def update_knowledge(item_id: int, body: dict = Body(...)):
    return crud_update(KnowledgeAsset, item_id, body, KNOWLEDGE_DIR, ".txt")


@app.delete("/api/knowledge/{item_id}")
def delete_knowledge(item_id: int):
    return crud_delete(KnowledgeAsset, item_id)


@app.get("/api/fewshots")
def list_fewshots(scene_id: Optional[int] = None):
    return crud_list(FewshotBook, scene_id)


@app.post("/api/fewshots")
def create_fewshot(body: dict = Body(...)):
    return crud_create(FewshotBook, body)


@app.put("/api/fewshots/{item_id}")
def update_fewshot(item_id: int, body: dict = Body(...)):
    return crud_update(FewshotBook, item_id, body)


@app.delete("/api/fewshots/{item_id}")
def delete_fewshot(item_id: int):
    return crud_delete(FewshotBook, item_id)


@app.get("/api/rules")
def list_rules(scene_id: Optional[int] = None):
    return crud_list(RuleAsset, scene_id)


@app.post("/api/rules")
def create_rule(body: dict = Body(...)):
    return crud_create(RuleAsset, body, CONFIG_DIR, ".json")


@app.put("/api/rules/{item_id}")
def update_rule(item_id: int, body: dict = Body(...)):
    return crud_update(RuleAsset, item_id, body, CONFIG_DIR, ".json")


@app.delete("/api/rules/{item_id}")
def delete_rule(item_id: int):
    return crud_delete(RuleAsset, item_id)


@app.get("/api/models")
def list_models():
    return crud_list(ModelConfig)


@app.post("/api/models")
def create_model(body: dict = Body(...)):
    return crud_create(ModelConfig, body, MODELS_DIR, ".yaml")


@app.put("/api/models/{item_id}")
def update_model(item_id: int, body: dict = Body(...)):
    return crud_update(ModelConfig, item_id, body, MODELS_DIR, ".yaml")


@app.delete("/api/models/{item_id}")
def delete_model(item_id: int):
    return crud_delete(ModelConfig, item_id)


@app.post("/api/annotations")
def create_annotations(body: dict = Body(...)):
    db = SessionLocal()
    try:
        scene_id = int(body["scene_id"])
        excel_file_id = int(body["excel_file_id"])
        model_config_id = int(body["model_config_id"])
        role_ids = [int(role_id) for role_id in body.get("role_ids", [])]
        row_ids = [int(row_id) for row_id in body.get("row_ids", [])]
        if not role_ids or not row_ids:
            raise HTTPException(400, "role_ids and row_ids are required")
        queued = []
        for row_id in row_ids:
            task = AnnotationTask(
                id=str(uuid4()),
                scene_id=scene_id,
                excel_file_id=excel_file_id,
                row_id=row_id,
                model_config_id=model_config_id,
                role_ids_json=json_dumps(role_ids),
                status="pending",
            )
            db.add(task)
            queued.append(task)
        db.commit()
        for task in queued:
            enqueue_task(task)
        return {"queued": len(queued), "tasks": [task_payload(task) for task in queued]}
    finally:
        db.close()


@app.get("/api/annotations/tasks")
def list_tasks(scene_id: Optional[int] = None, excel_file_id: Optional[int] = None):
    db = SessionLocal()
    try:
        query = db.query(AnnotationTask)
        if scene_id:
            query = query.filter(AnnotationTask.scene_id == scene_id)
        if excel_file_id:
            query = query.filter(AnnotationTask.excel_file_id == excel_file_id)
        return {"items": [task_payload(task) for task in query.order_by(AnnotationTask.created_at.desc()).limit(500).all()]}
    finally:
        db.close()


@app.post("/api/annotations/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    db = SessionLocal()
    try:
        task = db.query(AnnotationTask).filter(AnnotationTask.id == task_id).first()
        if not task:
            raise HTTPException(404, "Task not found")
        if task.status in TASK_ACTIVE_STATUSES:
            task.status = "cancelled"
            task.finished_at = now()
            db.commit()
        return {"item": task_payload(task)}
    finally:
        db.close()


@app.post("/api/annotations/tasks/cancel-pending")
def cancel_pending(body: dict = Body(...)):
    db = SessionLocal()
    try:
        query = db.query(AnnotationTask).filter(AnnotationTask.status == "pending")
        if body.get("scene_id"):
            query = query.filter(AnnotationTask.scene_id == int(body["scene_id"]))
        if body.get("excel_file_id"):
            query = query.filter(AnnotationTask.excel_file_id == int(body["excel_file_id"]))
        count = 0
        for task in query.all():
            task.status = "cancelled"
            task.finished_at = now()
            count += 1
        db.commit()
        return {"cancelled": count}
    finally:
        db.close()


@app.delete("/api/annotations")
def delete_annotations(body: dict = Body(...)):
    db = SessionLocal()
    try:
        query = db.query(AnnotationResult)
        if body.get("scene_id"):
            query = query.filter(AnnotationResult.scene_id == int(body["scene_id"]))
        if body.get("excel_file_id"):
            query = query.filter(AnnotationResult.excel_file_id == int(body["excel_file_id"]))
        if body.get("row_ids"):
            query = query.filter(AnnotationResult.row_id.in_([int(x) for x in body["row_ids"]]))
        deleted = query.delete(synchronize_session=False)
        db.commit()
        return {"deleted": deleted}
    finally:
        db.close()


@app.get("/api/stats")
def stats(scene_id: Optional[int] = None, excel_file_id: Optional[int] = None):
    db = SessionLocal()
    try:
        rows_query = db.query(ExcelRow)
        result_query = db.query(AnnotationResult)
        if scene_id:
            rows_query = rows_query.filter(ExcelRow.scene_id == scene_id)
            result_query = result_query.filter(AnnotationResult.scene_id == scene_id)
        if excel_file_id:
            rows_query = rows_query.filter(ExcelRow.excel_file_id == excel_file_id)
            result_query = result_query.filter(AnnotationResult.excel_file_id == excel_file_id)
        results = result_query.all()
        tp = sum(1 for item in results if item.match_type == "TP")
        fn = sum(1 for item in results if item.match_type == "FN")
        fp = sum(1 for item in results if item.match_type == "FP")
        tn = sum(1 for item in results if item.match_type == "TN")
        unknown = sum(1 for item in results if item.match_type == "UNKNOWN")
        denominator = tp + fn + fp + tn
        return {
            "total": rows_query.count(),
            "annotated": denominator,
            "unknown": unknown,
            "tp": tp,
            "fn": fn,
            "fp": fp,
            "tn": tn,
            "accuracy": ratio(tp + tn, denominator),
            "positive_recall": ratio(tp, tp + fn),
            "negative_recall": ratio(tn, tn + fp),
            "positive_precision": ratio(tp, tp + fp),
            "negative_precision": ratio(tn, tn + fn),
            "f1_score": ratio(2 * tp, 2 * tp + fp + fn),
        }
    finally:
        db.close()


@app.get("/api/export")
def export_excel(scene_id: int = Query(...), excel_file_id: Optional[int] = None):
    db = SessionLocal()
    try:
        query = db.query(ExcelRow).filter(ExcelRow.scene_id == scene_id)
        if excel_file_id:
            query = query.filter(ExcelRow.excel_file_id == excel_file_id)
        records = []
        for row in query.order_by(ExcelRow.id.asc()).all():
            data = json_loads(row.data, {})
            result = db.query(AnnotationResult).filter(AnnotationResult.row_id == row.id).order_by(AnnotationResult.created_at.desc()).first()
            if result:
                data.update({
                    "平台最终答案": result.final_label,
                    "平台匹配类型": result.match_type,
                    "平台错误信息": result.error,
                })
            records.append(data)
        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            pd.DataFrame(records).to_excel(writer, sheet_name="标注数据", index=False)
            pd.DataFrame([stats(scene_id, excel_file_id)]).to_excel(writer, sheet_name="统计数据", index=False)
        output.seek(0)
        filename = quote(f"数据飞轮导出_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}.xlsx")
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )
    finally:
        db.close()


@app.post("/api/chat")
def chat(body: dict = Body(...)):
    message = body.get("message", "")
    return {
        "reply": f"Mock 大模型回复：已收到 {len(message)} 个字符。真实模型调用可在 /api/chat 后续接入。",
        "created_at": now().isoformat(),
    }


@app.get("/favicon.ico")
def favicon():
    path = FRONTEND_DIST / "favicon.svg"
    if path.exists():
        return FileResponse(path, media_type="image/svg+xml")
    raise HTTPException(404, "favicon not found")


@app.get("/{full_path:path}", response_class=HTMLResponse)
def spa(full_path: str = ""):
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return HTMLResponse(index_path.read_text(encoding="utf-8"))
    legacy_path = BASE_DIR / "templates" / "index.html"
    if legacy_path.exists():
        return HTMLResponse(legacy_path.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>数据飞轮</h1><p>请先运行 npm run build。</p>")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=5001)
